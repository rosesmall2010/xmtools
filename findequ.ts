#!/usr/bin/env node
/**
 * findequ 工具：查找指定目录下所有文件，计算每个文件的 MD5，输出重复文件分组统计。
 *
 * 用法：node findequ.js /path/to/directory
 *
 * 输出 JSON：
 * {
 *   "path": "/path/to/directory",
 *   "file": { "md5值": ["文件路径1", "文件路径2", ...] },
 *   "total": {
 *     "fileCount": 文件总数,
 *     "totalSize": 文件总大小,
 *     "duplicateCount": 重复文件总数,
 *     "duplicateSize": 重复文件总大小,
 *     "md5Count": md5总数
 *   }
 * }
 *
 * 处理过程中输出人性化进度信息（当前文件、第几个/总共、当前文件大小、总大小、百分比）。
 */
import { utils } from 'xmcommon';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { FindEquResult } from './lib/equ';



/** 将字节数格式化为可读字符串 */
function formatSize(bytes: number): string {
    return utils.formatMemory(bytes);
}

/** 将毫秒格式化为 mm:ss */
function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 渲染一个固定宽度的进度条，如 [██████░░░░] */
function renderBar(percent: number, width = 50): string {
    const filled = Math.round((percent / 100) * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

/** 判断字符码点是否为宽字符（CJK 等），显示占 2 列 */
function isWideCodePoint(code: number): boolean {
    return (
        (code >= 0x1100 && code <= 0x115f) || // 韩文字母
        (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首、符号、汉字
        (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
        (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
        (code >= 0xff00 && code <= 0xff60) || // 全角标点
        (code >= 0xffe0 && code <= 0xffe6)
    );
}

/** 计算字符串在终端中的显示宽度（宽字符按 2 列计） */
function displayWidth(str: string): number {
    let width = 0;
    for (const ch of str) {
        width += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
    }
    return width;
}

/** 按显示宽度截断字符串，超出部分用 … 代替 */
function truncateToWidth(str: string, maxWidth: number): string {
    if (displayWidth(str) <= maxWidth) {
        return str;
    }
    let width = 0;
    let result = '';
    for (const ch of str) {
        const w = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
        if (width + w > maxWidth - 1) {
            break;
        }
        width += w;
        result += ch;
    }
    return `${result}…`;
}

/**
 * 多行进度面板：原地刷新固定行数的信息块（当前文件 / 进度条 / 文件数 / 字节数）。
 * 非 TTY（管道、重定向）环境下退化为普通逐行打印，避免转义字符污染输出。
 */
class ProgressPanel {
    private lineCount = 0;
    private readonly isTTY = Boolean(process.stdout.isTTY);

    render(lines: string[]): void {
        if (!this.isTTY) {
            console.log(lines.join(' | '));
            return;
        }
        // 按显示宽度截断，避免过长内容在终端自动换行导致下次上移行数与实际行数不符
        const width = process.stdout.columns || 80;
        const safeLines = lines.map((line) => truncateToWidth(line, width));
        if (this.lineCount > 0) {
            process.stdout.write(`\x1b[${this.lineCount}A`); // 光标上移到面板首行
        }
        for (const line of safeLines) {
            process.stdout.write(`\x1b[2K\r${line}\n`); // 清空整行后写入
        }
        this.lineCount = safeLines.length;
    }
}

/**
 * 递归收集目录下所有文件的绝对路径与大小。
 * 使用两步走：先列出文件清单（含大小），再逐个计算 MD5，以便先知道总数与总大小来展示进度。
 */
function listFiles(root: string): Array<{ file: string; size: number }> {
    const files: Array<{ file: string; size: number }> = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (err) {
            console.warn(`无法读取目录: ${current} (${(err as Error).message})`);
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            try {
                if (entry.isDirectory()) {
                    stack.push(full);
                } else if (entry.isFile()) {
                    const stat = fs.statSync(full);
                    files.push({ file: full, size: stat.size });
                }
            } catch (err) {
                console.warn(`跳过: ${full} (${(err as Error).message})`);
            }
        }
    }
    return files;
}

/** 计算单个文件的 MD5（同步逐块读取，大文件不占内存） */
function md5File(filePath: string): string {
    const hash = crypto.createHash('md5');
    const chunk = Buffer.alloc(1024 * 1024);
    let fd: number | null = null;
    try {
        fd = fs.openSync(filePath, 'r');
        let bytesRead: number;
        while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
            hash.update(chunk.subarray(0, bytesRead));
        }
    } finally {
        if (fd !== null) {
            fs.closeSync(fd);
        }
    }
    return hash.digest('hex');
}

function main(): void {
    const target = process.argv[2];
    if (!target) {
        console.error('用法: node findequ.js <目录路径>');
        process.exit(1);
    }
    const absTarget = path.resolve(target);
    if (!fs.existsSync(absTarget) || !fs.statSync(absTarget).isDirectory()) {
        console.error(`错误: 目录不存在或不是目录: ${absTarget}`);
        process.exit(1);
    }

    console.log(`开始扫描目录: ${absTarget}`);

    // 第一步：收集文件清单
    const files = listFiles(absTarget);
    const totalCount = files.length;
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    console.log(`发现 ${totalCount} 个文件，总大小 ${formatSize(totalSize)}`);

    // 第二步：计算 MD5 并展示多行进度面板
    const pathsByMd5: Record<string, string[]> = {};
    let processed = 0;
    let processedSize = 0;
    const startTime = Date.now();
    let lastRender = 0;
    const panel = new ProgressPanel();

    for (const { file, size } of files) {
        processed++;
        processedSize += size;
        const relFile = path.relative(absTarget, file);
        try {
            const hash = md5File(file);
            (pathsByMd5[hash] ??= []).push(relFile);
        } catch (err) {
            console.warn(`跳过（读取失败）: ${relFile} (${(err as Error).message})`);
        }

        const now = Date.now();
        const isLast = processed === totalCount;
        // 节流：最多每 80ms 刷新一次面板，避免海量小文件时疯狂刷屏；最后一个文件必刷
        if (isLast || now - lastRender >= 80) {
            lastRender = now;
            const filePercent = totalCount === 0 ? 100 : (processed / totalCount) * 100;
            const bytePercent = totalSize === 0 ? 100 : (processedSize / totalSize) * 100;
            const elapsedMs = now - startTime;
            const speed = elapsedMs > 0 ? processedSize / (elapsedMs / 1000) : 0;
            const etaMs = speed > 0 ? ((totalSize - processedSize) / speed) * 1000 : 0;

            panel.render([
                `当前处理: ${relFile}`,
                `进度条  : ${renderBar(bytePercent)} ${bytePercent.toFixed(1).padStart(5)}%`,
                `文件数  : ${processed}/${totalCount} (${filePercent.toFixed(1)}%)`,
                `字节数  : ${formatSize(processedSize)}/${formatSize(totalSize)} (${bytePercent.toFixed(1)}%)`,
                `速度/耗时: ${formatSize(speed)}/s  已用 ${formatDuration(elapsedMs)}  剩余 ${formatDuration(etaMs)}`,
            ]);
        }
    }

    // 统计（复用扫描阶段已知的大小，避免重复 statSync 且不受文件后续消失影响）
    const sizeByRelPath = new Map(files.map((f) => [path.relative(absTarget, f.file), f.size]));
    const fileMap: FindEquResult['file'] = {};
    let duplicateCount = 0;
    let duplicateSize = 0;
    let md5Count = 0;
    for (const md5 of Object.keys(pathsByMd5)) {
        const paths = pathsByMd5[md5];
        const size = sizeByRelPath.get(paths[0]) ?? 0;
        fileMap[md5] = { size: formatSize(size), count: paths.length, paths };
        if (paths.length > 1) {
            md5Count++;
            duplicateCount += paths.length;
            duplicateSize += size * paths.length;
        }
    }

    const result: FindEquResult = {
        path: absTarget,
        file: fileMap,
        total: {
            fileCount: totalCount,
            totalSize: formatSize(totalSize),
            duplicateCount,
            duplicateSize: formatSize(duplicateSize),
            md5Count,
        },
    };
    const outFile = path.resolve(`findequ-result-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`处理完成，结果已保存到: ${outFile}`);
}

main();

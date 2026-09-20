#!/usr/bin/env node
/**
 * mvflat 工具：递归把源目录下指定扩展名的文件移动到目标目录，不保留相对路径（拍平）。
 *
 * 用法：node mvflat.js <源目录> <目标目录> <扩展名>
 *
 * <扩展名> 只匹配文件名最后一个点之后的部分（大小写不敏感，可带或不带前导点，如 mp3 / .mp3）；
 * 传 * 表示不筛选，移动所有文件（包括没有扩展名的文件）。
 *
 * 若目标目录已存在同名文件（重名冲突），参照 renametag 的做法：在扩展名前插入一个编号再试，
 * 编号从 1 开始，每使用一次（无论是否成功）就 +1，在本次运行中递增、不会重复使用，
 * 仍冲突则继续用下一个编号重试，直到文件名不冲突为止。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface MvFlatResult {
    source: string;
    target: string;
    ext: string;
    moved: Array<{ from: string; to: string }>;
    skipped: Array<{ path: string; reason: string }>;
    total: { movedCount: number; skippedCount: number };
}

/** 递归收集目录下所有文件的绝对路径 */
function listFiles(root: string): string[] {
    const files: string[] = [];
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
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile()) {
                files.push(full);
            }
        }
    }
    return files;
}

/** 按最后一个点拆分文件名为 [不含扩展名部分, 扩展名]；没有扩展名时扩展名为空串 */
function splitExt(name: string): [string, string] {
    const idx = name.lastIndexOf('.');
    return idx <= 0 ? [name, ''] : [name.slice(0, idx), name.slice(idx + 1)];
}

function main(): void {
    const [, , source, target, ext] = process.argv;
    if (!source || !target || !ext) {
        console.error('用法: node mvflat.js <源目录> <目标目录> <扩展名（如 mp3，* 表示全部）>');
        process.exit(1);
    }
    const absSource = path.resolve(source);
    const absTarget = path.resolve(target);
    if (!fs.existsSync(absSource) || !fs.statSync(absSource).isDirectory()) {
        console.error(`错误: 源目录不存在或不是目录: ${absSource}`);
        process.exit(1);
    }
    if (fs.existsSync(absTarget) && !fs.statSync(absTarget).isDirectory()) {
        console.error(`错误: 目标路径已存在但不是目录: ${absTarget}`);
        process.exit(1);
    }
    fs.mkdirSync(absTarget, { recursive: true });

    const normExt = ext === '*' ? '*' : (ext.startsWith('.') ? ext.slice(1) : ext).toLowerCase();
    const matchExt = (base: string): boolean => {
        if (normExt === '*') {
            return true;
        }
        const [, fileExt] = splitExt(base);
        return fileExt.toLowerCase() === normExt;
    };

    const files = listFiles(absSource).filter((file) => matchExt(path.basename(file)));
    const moved: Array<{ from: string; to: string }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let dupCounter = 1; // 冲突编号：本次运行内递增，用过的编号不会再用

    for (const file of files) {
        const relFrom = path.relative(absSource, file);
        const base = path.basename(file);
        let destPath = path.join(absTarget, base);

        if (path.resolve(file) === destPath) {
            continue; // 已经在目标目录下的正确位置，无需移动
        }

        if (fs.existsSync(destPath)) {
            const [nameNoExt, fileExt] = splitExt(base);
            do {
                const numbered = fileExt ? `${nameNoExt}.${dupCounter++}.${fileExt}` : `${nameNoExt}.${dupCounter++}`;
                destPath = path.join(absTarget, numbered);
            } while (fs.existsSync(destPath));
        }

        try {
            fs.renameSync(file, destPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
                try {
                    fs.copyFileSync(file, destPath);
                    fs.unlinkSync(file);
                } catch (copyErr) {
                    console.warn(`跳过（移动失败）: ${relFrom} (${(copyErr as Error).message})`);
                    skipped.push({ path: relFrom, reason: `移动失败: ${(copyErr as Error).message}` });
                    continue;
                }
            } else {
                console.warn(`跳过（移动失败）: ${relFrom} (${(err as Error).message})`);
                skipped.push({ path: relFrom, reason: `移动失败: ${(err as Error).message}` });
                continue;
            }
        }
        const relTo = path.basename(destPath);
        console.log(`已移动: ${relFrom} -> ${relTo}`);
        moved.push({ from: relFrom, to: relTo });
    }

    const result: MvFlatResult = {
        source: absSource,
        target: absTarget,
        ext: normExt,
        moved,
        skipped,
        total: { movedCount: moved.length, skippedCount: skipped.length },
    };
    const outFile = path.resolve(`mvflat-result-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`处理完成，共移动 ${moved.length} 个，跳过 ${skipped.length} 个，结果已保存到: ${outFile}`);
}

main();

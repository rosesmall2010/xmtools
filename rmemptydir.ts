#!/usr/bin/env node
/**
 * rmemptydir 工具：递归删除指定目录下所有的空子目录（目标目录本身不删除）。
 *
 * 递归逻辑：自底向上——先处理子目录，子目录被删除后父目录也可能因此变空，
 * 于是逐级向上级联删除，直到不再产生新的空目录（目标目录本身除外）。
 *
 * 用法：node rmemptydir.js <目录路径>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface RmEmptyDirResult {
    path: string;
    removed: string[];
    skipped: Array<{ path: string; reason: string }>;
    total: { removedCount: number; skippedCount: number };
}

const removed: string[] = [];
const skipped: Array<{ path: string; reason: string }> = [];

/**
 * 递归清理 dir 下的空子目录，返回 dir 自身在清理后是否为空。
 * 目标目录（root）本身从不在此函数内被删除——删除动作只发生在父目录的调用处。
 */
function cleanDir(dir: string, root: string): boolean {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        skipped.push({ path: path.relative(root, dir) || '.', reason: `读取目录失败: ${(err as Error).message}` });
        return false;
    }

    let hasRemaining = false;
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (!entry.isDirectory()) {
            hasRemaining = true; // 文件、符号链接等均视为非空
            continue;
        }
        const childEmpty = cleanDir(full, root);
        if (!childEmpty) {
            hasRemaining = true;
            continue;
        }
        const rel = path.relative(root, full);
        try {
            fs.rmdirSync(full);
        } catch (err) {
            skipped.push({ path: rel, reason: `删除失败: ${(err as Error).message}` });
            hasRemaining = true;
            continue;
        }
        console.log(`已删除空目录: ${rel}`);
        removed.push(rel);
    }
    return !hasRemaining;
}

function main(): void {
    const target = process.argv[2];
    if (!target) {
        console.error('用法: node rmemptydir.js <目录路径>');
        process.exit(1);
    }
    const absTarget = path.resolve(target);
    if (!fs.existsSync(absTarget) || !fs.statSync(absTarget).isDirectory()) {
        console.error(`错误: 目录不存在或不是目录: ${absTarget}`);
        process.exit(1);
    }

    cleanDir(absTarget, absTarget);

    const result: RmEmptyDirResult = {
        path: absTarget,
        removed,
        skipped,
        total: { removedCount: removed.length, skippedCount: skipped.length },
    };
    const outFile = path.resolve(`rmemptydir-result-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`处理完成，共删除空目录 ${removed.length} 个，跳过 ${skipped.length} 个，结果已保存到: ${outFile}`);
}

main();

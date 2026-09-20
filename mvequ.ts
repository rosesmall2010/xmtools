#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FindEquResult } from './lib/equ';

/**
 * 这里要实现一个命令行工具，把findequ.ts的结果，对于重复的文件，保持相对路径，移动到指定的目录下
 * 用法：node mvequ.js findequ-result.json /path/to/target
 * 注意是移动文件，而不是复制文件，删除原来的文件， 路径也要保持相对路径，例如：
 * 例如： /data/music   的 mp3/a.mp3 => /data/music2   的 mp3/a.mp3
 *
 * 每组重复文件（同一 md5，count > 1）保留第一个文件在原处，其余的移动到目标目录。
 */
async function main() {
    const [, , resultFile, targetDir] = process.argv;
    if (!resultFile || !targetDir) {
        console.error('用法: node mvequ.js <findequ-result.json> <目标目录>');
        process.exit(1);
    }

    const result: FindEquResult = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    const sourceRoot = result.path;
    const absTarget = path.resolve(targetDir);

    let movedCount = 0;
    let skippedCount = 0;

    for (const md5 of Object.keys(result.file)) {
        const { paths } = result.file[md5];
        if (paths.length <= 1) {
            continue; // 非重复文件，跳过
        }
        // 保留第一个文件在原处，其余的按相对路径移动到目标目录
        for (const relPath of paths.slice(1)) {
            const src = path.join(sourceRoot, relPath);
            const dest = path.join(absTarget, relPath);

            if (!fs.existsSync(src)) {
                console.warn(`跳过（源文件不存在）: ${relPath}`);
                skippedCount++;
                continue;
            }
            if (fs.existsSync(dest)) {
                console.warn(`跳过（目标已存在）: ${relPath}`);
                skippedCount++;
                continue;
            }

            fs.mkdirSync(path.dirname(dest), { recursive: true });
            try {
                fs.renameSync(src, dest);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
                    // 跨设备无法 rename，退化为复制后删除源文件
                    fs.copyFileSync(src, dest);
                    fs.unlinkSync(src);
                } else {
                    console.warn(`跳过（移动失败）: ${relPath} (${(err as Error).message})`);
                    skippedCount++;
                    continue;
                }
            }
            console.log(`已移动: ${relPath}`);
            movedCount++;
        }
    }

    console.log(`完成，共移动 ${movedCount} 个文件，跳过 ${skippedCount} 个。`);
}

main();

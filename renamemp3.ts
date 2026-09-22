#!/usr/bin/env node
/**
 * renamemp3 工具：读取 nametag 的结果 JSON，按 star_name 批量重命名音乐文件，
 * 并同步重命名同目录下配套的歌词文件（同名 .lrc，忽略大小写）。
 *
 * 用法：node renamemp3.js <nametag-result.json> <音乐根目录>
 *
 * <音乐根目录> 是 mp3info 当初扫描的根目录（nametag 结果里的 path 是相对它的相对路径）。
 *
 * 规则：
 * - star_name 为空的记录跳过（无法可靠推断，保持原样，人工处理）。
 * - 目标名 = star_name + 原扩展名；若源文件旁存在同名 .lrc，一起改名为 star_name.lrc。
 * - 目标已存在（mp3 或 lrc 冲突）时，在扩展名前插入编号再试（与 renametag 一致）：
 *   "歌手 - 歌名.mp3" 已存在 => "歌手 - 歌名.1.mp3"，lrc 同步 "歌手 - 歌名.1.lrc"。
 * - 先改名 mp3、成功后再改名 lrc：mp3 失败时 lrc 不动，不破坏对应关系。
 *
 * 处理结果保存到 renamemp3-result-<时间戳>.json。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface RenameMp3Result {
    input: string;
    root: string;
    renamed: Array<{ from: string; to: string; lrcFrom: string; lrcTo: string }>;
    skipped: Array<{ path: string; reason: string }>;
    total: { renamedCount: number; skippedCount: number; lrcCount: number };
}

interface NametagEntry {
    name: string;
    path?: string;
    star_name: string;
}

/** 按目录缓存 readdir，避免每文件重复扫目录（大量 mp3 集中在少数目录时省时） */
const dirCache = new Map<string, string[]>();
function readDirCached(dir: string): string[] {
    let entries = dirCache.get(dir);
    if (!entries) {
        try {
            entries = fs.readdirSync(dir);
        } catch {
            entries = [];
        }
        dirCache.set(dir, entries);
    }
    return entries;
}

/** 找目录下与 base 同名的 .lrc（忽略扩展名大小写），返回实际文件名；不存在返回 null */
function findSiblingLrc(dir: string, base: string): string | null {
    const want = base.toLowerCase() + '.lrc';
    const hit = readDirCached(dir).find((n) => n.toLowerCase() === want);
    return hit ? path.join(dir, hit) : null;
}

function main(): void {
    const input = process.argv[2];
    const rootArg = process.argv[3];
    if (!input || !rootArg) {
        console.error('用法: node renamemp3.js <nametag-result.json> <音乐根目录>');
        process.exit(1);
    }
    if (!fs.existsSync(input)) {
        console.error(`错误: 文件不存在: ${input}`);
        process.exit(1);
    }
    const root = path.resolve(rootArg);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        console.error(`错误: 音乐根目录不存在或不是目录: ${root}`);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(input, 'utf8')) as { files: NametagEntry[] };
    const renamed: RenameMp3Result['renamed'] = [];
    const skipped: RenameMp3Result['skipped'] = [];
    let lrcCount = 0;

    for (const f of data.files) {
        // mp3info 在 Windows 上输出反斜杠分隔的相对路径，归一化成 `/` 保证任意平台定位正确
        const rel = (f.path || f.name).replace(/\\/g, '/');
        if (!f.star_name) {
            skipped.push({ path: rel, reason: 'star_name 为空' });
            continue;
        }
        const src = path.join(root, rel);
        if (!fs.existsSync(src)) {
            skipped.push({ path: rel, reason: '源文件不存在' });
            continue;
        }
        const dir = path.dirname(src);
        const srcExt = path.extname(src);
        const srcBase = path.basename(src, srcExt);
        const srcLrc = findSiblingLrc(dir, srcBase);
        const hasLrc = srcLrc !== null;

        // 目标名；与原名相同则无需改名
        let target = path.join(dir, f.star_name + srcExt);
        let targetLrc = path.join(dir, f.star_name + '.lrc');
        if (path.basename(target) === path.basename(src) &&
            (!hasLrc || path.basename(targetLrc).toLowerCase() === path.basename(srcLrc!).toLowerCase())) {
            continue;
        }
        // 冲突：mp3 或 lrc 任一目标已存在 → 追加 .N，直到两者都不冲突
        let n = 1;
        while (fs.existsSync(target) || (hasLrc && fs.existsSync(targetLrc))) {
            target = path.join(dir, `${f.star_name}.${n}${srcExt}`);
            targetLrc = path.join(dir, `${f.star_name}.${n}.lrc`);
            n++;
        }

        const relTo = path.relative(root, target);
        const relLrcFrom = hasLrc ? path.relative(root, srcLrc!) : '';
        const relLrcTo = hasLrc ? path.relative(root, targetLrc) : '';
        try {
            fs.renameSync(src, target);
            if (hasLrc) {
                fs.renameSync(srcLrc!, targetLrc);
                lrcCount++;
            }
        } catch (err) {
            console.warn(`跳过（重命名失败）: ${rel} (${(err as Error).message})`);
            skipped.push({ path: rel, reason: `重命名失败: ${(err as Error).message}` });
            continue;
        }
        console.log(`已重命名: ${rel} -> ${relTo}${hasLrc ? `（歌词 ${relLrcFrom} -> ${relLrcTo}）` : ''}`);
        renamed.push({ from: rel, to: relTo, lrcFrom: relLrcFrom, lrcTo: relLrcTo });
    }

    const result: RenameMp3Result = {
        input,
        root,
        renamed,
        skipped,
        total: { renamedCount: renamed.length, skippedCount: skipped.length, lrcCount },
    };
    const outFile = path.resolve(`renamemp3-result-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`处理完成，共重命名 ${renamed.length} 个，跳过 ${skipped.length} 个（其中同步改名歌词 ${lrcCount} 个），结果已保存到: ${outFile}`);
}

main();

#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * renametag 工具：修正文件名——把开头的"数字前缀"或"3D / 3 D 前缀"移动到扩展名之前，
 * 并规范化文件名中连字符 "-" 前后的空格。
 *
 * 用法：node renametag.js <目录路径>
 *
 * 处理规则（均只作用于文件名本身，不含路径、不含扩展名）：
 * - 数字前缀：文件名以数字开头、以点分隔（如 13456.AAA.mp3），且数字后面除扩展名外还有内容时，
 *   把数字移到扩展名前：13456.AAA.mp3 => AAA.13456.mp3。
 *   若数字后紧跟的就是扩展名（如 12345.mp3，只有"数字.扩展名"两段），不处理。
 * - 3D / 3 D 前缀：直接附着在文件名开头（无需用点分隔，如 3DAAA.mp3），把该前缀移到扩展名前：
 *   3DAAA.mp3 => AAA.3D.mp3。
 * - 连字符规范化：连续多个 "-"（中间可有空格，如 "- -"）先合并成一个 "-"，再统一改成 " - "：
 *   张三-AAA.mp3 => 张三 - AAA.mp3；张三- -AAA.mp3 => 张三 - AAA.mp3。
 * - 改名冲突处理：若改名后的目标文件名已存在，在扩展名前插入一个编号再试。编号从 1 开始，
 *   每使用一次（无论是否成功）就 +1，在本次运行中递增、不会重复使用：
 *   张三 - AAA.mp3 已存在 => 张三 - AAA.9.mp3，仍冲突则用 10、11……直到不冲突为止。
 *
 * 递归扫描目录下所有文件，处理结果保存到 renametag-result-<时间戳>.json。
 */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * 计算文件名调整数字/3D 前缀位置、规范化连字符空格后的新文件名。
 * 无需任何调整时返回 null（保持原名）。
 */
function computeRenamed(filename) {
    const parts = filename.split('.');
    if (parts.length < 2 || parts.some((p) => p.length === 0)) {
        return null; // 没有扩展名，或存在连续点产生的空segment（如 "123..mp3"），不处理
    }
    const ext = parts[parts.length - 1];
    const first = parts[0];
    const middle = parts.slice(1, -1);
    let nameParts;
    if (/^\d+$/.test(first)) {
        // 数字前缀：数字后除扩展名外还有内容时才移到末尾，仅"数字.扩展名"保持原样
        nameParts = middle.length === 0 ? [first] : [...middle, first];
    }
    else {
        // ponytail: 只处理 "3D"/"3 D" 紧贴文件名开头且后面还有内容的情况，如 "3D.AAA.mp3"（点分隔）未覆盖
        const tagMatch = first.match(/^(3\s?D)(.+)$/i);
        nameParts = tagMatch ? [tagMatch[2], ...middle, tagMatch[1]] : [first, ...middle];
    }
    // 连字符规范化：连续多个 '-'（中间可有空格，如 "- -"）先合并成一个 '-'，
    // 再统一把 '-' 前后没有恰好一个空格的情况改成 " - "
    const normalizedParts = nameParts.map((p) => p.replace(/-(?:\s*-)+/g, '-').replace(/\s*-\s*/g, ' - '));
    const newName = [...normalizedParts, ext].join('.');
    return newName === filename ? null : newName;
}
/** 按最后一个点拆分文件名为 [不含扩展名部分, 扩展名] */
function splitExt(name) {
    const idx = name.lastIndexOf('.');
    return [name.slice(0, idx), name.slice(idx + 1)];
}
/** 递归收集目录下所有文件的绝对路径 */
function listFiles(root) {
    const files = [];
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch (err) {
            console.warn(`无法读取目录: ${current} (${err.message})`);
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            }
            else if (entry.isFile()) {
                files.push(full);
            }
        }
    }
    return files;
}
function main() {
    const target = process.argv[2];
    if (!target) {
        console.error('用法: node renametag.js <目录路径>');
        process.exit(1);
    }
    const absTarget = path.resolve(target);
    if (!fs.existsSync(absTarget) || !fs.statSync(absTarget).isDirectory()) {
        console.error(`错误: 目录不存在或不是目录: ${absTarget}`);
        process.exit(1);
    }
    const files = listFiles(absTarget);
    const renamed = [];
    const skipped = [];
    let dupCounter = 1; // 冲突编号：本次运行内递增，用过的编号不会再用
    for (const file of files) {
        const base = path.basename(file);
        const newBase = computeRenamed(base);
        if (!newBase || newBase === base) {
            continue;
        }
        const relFrom = path.relative(absTarget, file);
        const dir = path.dirname(file);
        let newPath = path.join(dir, newBase);
        if (fs.existsSync(newPath)) {
            const [nameNoExt, ext] = splitExt(newBase);
            do {
                newPath = path.join(dir, `${nameNoExt}.${dupCounter++}.${ext}`);
            } while (fs.existsSync(newPath));
        }
        const relTo = path.relative(absTarget, newPath);
        try {
            fs.renameSync(file, newPath);
        }
        catch (err) {
            console.warn(`跳过（重命名失败）: ${relFrom} (${err.message})`);
            skipped.push({ path: relFrom, reason: `重命名失败: ${err.message}` });
            continue;
        }
        console.log(`已重命名: ${relFrom} -> ${relTo}`);
        renamed.push({ from: relFrom, to: relTo });
    }
    const result = {
        path: absTarget,
        renamed,
        skipped,
        total: { renamedCount: renamed.length, skippedCount: skipped.length },
    };
    const outFile = path.resolve(`renametag-result-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`处理完成，共重命名 ${renamed.length} 个，跳过 ${skipped.length} 个，结果已保存到: ${outFile}`);
}
main();

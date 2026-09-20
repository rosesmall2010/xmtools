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
 * mvflat 工具：递归把源目录下所有文件移动到目标目录，不保留相对路径（拍平）。
 *
 * 用法：node mvflat.js <源目录> <目标目录>
 *
 * 若目标目录已存在同名文件（重名冲突），参照 renametag 的做法：在扩展名前插入一个编号再试，
 * 编号从 1 开始，每使用一次（无论是否成功）就 +1，在本次运行中递增、不会重复使用，
 * 仍冲突则继续用下一个编号重试，直到文件名不冲突为止。
 */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
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
/** 按最后一个点拆分文件名为 [不含扩展名部分, 扩展名]；没有扩展名时扩展名为空串 */
function splitExt(name) {
    const idx = name.lastIndexOf('.');
    return idx <= 0 ? [name, ''] : [name.slice(0, idx), name.slice(idx + 1)];
}
function main() {
    const [, , source, target] = process.argv;
    if (!source || !target) {
        console.error('用法: node mvflat.js <源目录> <目标目录>');
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
    const files = listFiles(absSource);
    const moved = [];
    const skipped = [];
    let dupCounter = 1; // 冲突编号：本次运行内递增，用过的编号不会再用
    for (const file of files) {
        const relFrom = path.relative(absSource, file);
        const base = path.basename(file);
        let destPath = path.join(absTarget, base);
        if (path.resolve(file) === destPath) {
            continue; // 已经在目标目录下的正确位置，无需移动
        }
        if (fs.existsSync(destPath)) {
            const [nameNoExt, ext] = splitExt(base);
            do {
                const numbered = ext ? `${nameNoExt}.${dupCounter++}.${ext}` : `${nameNoExt}.${dupCounter++}`;
                destPath = path.join(absTarget, numbered);
            } while (fs.existsSync(destPath));
        }
        try {
            fs.renameSync(file, destPath);
        }
        catch (err) {
            if (err.code === 'EXDEV') {
                try {
                    fs.copyFileSync(file, destPath);
                    fs.unlinkSync(file);
                }
                catch (copyErr) {
                    console.warn(`跳过（移动失败）: ${relFrom} (${copyErr.message})`);
                    skipped.push({ path: relFrom, reason: `移动失败: ${copyErr.message}` });
                    continue;
                }
            }
            else {
                console.warn(`跳过（移动失败）: ${relFrom} (${err.message})`);
                skipped.push({ path: relFrom, reason: `移动失败: ${err.message}` });
                continue;
            }
        }
        const relTo = path.basename(destPath);
        console.log(`已移动: ${relFrom} -> ${relTo}`);
        moved.push({ from: relFrom, to: relTo });
    }
    const result = {
        source: absSource,
        target: absTarget,
        moved,
        skipped,
        total: { movedCount: moved.length, skippedCount: skipped.length },
    };
    const outFile = path.resolve(`mvflat-result-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`处理完成，共移动 ${moved.length} 个，跳过 ${skipped.length} 个，结果已保存到: ${outFile}`);
}
main();

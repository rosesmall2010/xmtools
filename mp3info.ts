#!/usr/bin/env node
/**
 * mp3info 工具：递归扫描目录下所有 .mp3 文件，提取 ID3 标签与音频参数。
 *
 * 用法：node mp3info.js <目录路径>
 *
 * 提取的信息：
 * - 文件：文件名、相对路径、文件大小
 * - ID3 标签：歌手、歌曲名、专辑、年份、流派（每个字段最多保留 50 个字符，超出截取），
 *   并标注每个字段的原始编码（utf8 / utf16 / gbk / latin1乱码还原 / big5乱码还原）
 * - 音频参数：码率、时长、采样率、声道（单声道/立体声等）
 *
 * 编码检测：ID3v2 文本帧带一个编码字节（0=ISO-8859-1、1=UTF-16 带 BOM、2=UTF-16BE、3=UTF-8），
 * 但历史上大量中文标签虽然声明 0（ISO-8859-1），实际写入的是 GBK/GB2312 字节。
 * 因此对非 ASCII 内容：先按严格 UTF-8 解码，失败则按 GB18030（兼容 GBK/GB2312）解码；
 * 声明 UTF-8 却仍是「GBK 字节被当 ISO-8859-1」的乱码（如 `Ã«°¢Ãô`）时，再按 latin1→GBK 还原一次；
 * 若结果仍是乱码，再依次尝试还原「Big5 字节被当 GBK」一类乱码。
 *
 * ID3v1 兜底：无 ID3v2 标签时读取文件末尾 128 字节的 TAG 块（同样按 UTF-8/GB18030 探测解码）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { utils } from 'xmcommon';

/** 每个 ID3 文本字段最多保留的字符数 */
const MAX_FIELD_CHARS = 50;

/** ID3v2.2 的 3 字符帧 ID → ID3v2.3/2.4 的 4 字符 ID */
const V22_FRAME_IDS: Record<string, string> = {
    BUF: 'RBUF', CNT: 'PCNT', COM: 'COMM', CRA: 'AENC', ETC: 'ETCO', EQU: 'EQUA',
    GEO: 'GEOB', IPL: 'IPLS', LNK: 'LINK', MCI: 'MCDI', MLL: 'MLLT', PIC: 'APIC',
    POP: 'POPM', REV: 'RVRB', RVA: 'RVAD', SLT: 'SYLT', STC: 'SYTC', TAL: 'TALB',
    TBP: 'TBPM', TCM: 'TCOM', TCO: 'TCON', TCR: 'TCOP', TDA: 'TDAT', TDY: 'TDLY',
    TEN: 'TENC', TFT: 'TFLT', TIM: 'TIME', TKE: 'TKEY', TLA: 'TLAN', TLE: 'TLEN',
    TMT: 'TMED', TOA: 'TOPE', TOF: 'TOFN', TOL: 'TOLY', TOR: 'TORY', TOT: 'TOAL',
    TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TP4: 'TPE4', TPA: 'TPOS', TPB: 'TPUB',
    TRC: 'TSRC', TRD: 'TRDA', TRK: 'TRCK', TSI: 'TSIZ', TSS: 'TSSE', TT1: 'TIT1',
    TT2: 'TIT2', TT3: 'TIT3', TXT: 'TEXT', TXX: 'TXXX', TYE: 'TYER', UFI: 'UFID',
    ULT: 'USLT', WAF: 'WOAF', WAR: 'WOAR', WAS: 'WOAS', WCM: 'WCOM', WCP: 'WCOP',
    WPB: 'WPUB', WXX: 'WXXX',
};

interface Mp3Info {
    name: string;
    path: string;
    size: string;
    id3Version: string;
    /** ID3 是否发生变化：传入 --update 时是「已写回」，否则是「需要写回」的预告 */
    id3Changed: boolean;
    title: string;
    titleEnc: string;
    artist: string;
    artistEnc: string;
    album: string;
    albumEnc: string;
    year: string;
    yearEnc: string;
    genre: string;
    genreEnc: string;
    bitrate: string;
    duration: string;
    /** 精确时长（毫秒），供汇总 totalDuration 累加（duration 字符串会因 hh:mm:ss 丢失精度） */
    durationMs: number;
    sampleRate: string;
    channel: string;
}

interface Mp3InfoResult {
    path: string;
    files: Mp3Info[];
    skipped: Array<{ path: string; reason: string }>;
    noTags: Array<{ path: string; id3Version: string }>;
    total: {
        fileCount: number;
        skippedCount: number;
        noTagCount: number;
        /** ID3 有变化的文件数（--update 时即实际写回数） */
        changedCount: number;
        unchangedCount: number;
        totalDuration: string;
        vbrCount: number;
        encCount: Record<string, number>;
    };
}

/** readMp3 解析结果：info 供输出，其余字段供 --update 写回 */
interface ParsedMp3 {
    info: Mp3Info;
    /** 未截断的解码原文（写回时必须用原文，info 里的字段已截到 50 字符） */
    tags: Map<string, string>;
    tagEnc: Map<string, string>;
    /** COMM 帧的 3 字节语言码，写回时原样保留 */
    commLang: Map<string, string>;
    /** 原标签里每个帧的原始字节（含帧头）。写回时除需转码的帧外全部原样保留，
     *  否则封面 APIC、歌词 USLT 等工具没解码的帧会在重建标签时被丢掉 */
    rawFrames: Buffer[];
    /** 原标签正文总长度（含帧与填充），写回时照此长度补齐，保持文件大小不变 */
    tagBodyLen: number;
    audioStart: number;
    buf: Buffer;
    /** 任一非空字段的编码不是 utf8 → 需要写回 */
    changed: boolean;
}

/** 缓存的严格 UTF-8/GB18030 解码器（fatal 模式：无法解码时抛错，用于判定编码） */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const gb18030 = new TextDecoder('gb18030');

/** 控制字符（含删除符）、Unicode 私有区、替换符——出现即说明解码结果不可信 */
const RE_BAD_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uE000-\uF8FF\uFFFD]/;
const RE_CJK = /[\u3400-\u9FFF\uAC00-\uD7AF]/;

/**
 * 把「GBK 字节被当成 ISO-8859-1 解码」的乱码还原回原文。
 *
 * 老打标工具常把 GBK 标签写成 encoding=0（ISO-8859-1），于是 `Îé°Û` 这种串出现。
 * 判据：整串字符全在 U+0080–U+00FF 且高位字符占比过半（纯英文不会命中）；
 * 还原后必须无控制符/替换符且含汉字才接受——否则源字节本已损坏，无法还原。
 */
function repairLatin1Mojibake(text: string): string {
    if (!text) {
        return text;
    }
    let high = 0;
    for (const ch of text) {
        const c = ch.codePointAt(0) as number;
        if (c > 0xff) {
            return text;
        }
        if (c >= 0x80) {
            high++;
        }
    }
    if (high / text.length < 0.5) {
        return text;
    }
    const raw = Buffer.from([...text].map((c) => c.codePointAt(0) as number));
    const fixed = gb18030.decode(raw);
    return !RE_BAD_TEXT.test(fixed) && RE_CJK.test(fixed) ? fixed : text;
}

/**
 * Big5 乱码的可疑信号：控制符/私有区/替换符，加上 CJK 兼容形式、注音符号、CJK 兼容汉字。
 * 正常简体字几乎不落到这些区，而 Big5 字节被当 GBK 解码时经常落到那里。
 */
const RE_BIG5_SUSPECT =
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-�︰-﹏ㄅ-ㄯ豈-﫿]/;

/**
 * Big5 反查表：字符 → 原始 Big5 字节对。仅收录「该字节对按 GB18030 解码恰好得到 1 个字符」
 * 的一一对应项（约 1.4 万），用于还原「Big5 字节被当 GBK 解码」的乱码。
 * 懒加载：只有真的遇到可疑文本才建表。
 */
let big5Reverse: Map<string, number> | null = null;

function getBig5Reverse(): Map<string, number> {
    if (big5Reverse) {
        return big5Reverse;
    }
    big5Reverse = new Map<string, number>();
    for (let lead = 0xa1; lead <= 0xf9; lead++) {
        for (let trail = 0x40; trail <= 0xfe; trail++) {
            if (trail > 0x7e && trail < 0xa1) {
                continue;
            }
            const ch = gb18030.decode(Buffer.from([lead, trail]));
            if ([...ch].length !== 1) {
                continue;
            }
            // 同一 GBK 字符对应多个 Big5 字节时无法唯一还原，作废
            big5Reverse.set(ch, big5Reverse.has(ch) ? -1 : (lead << 8) | trail);
        }
    }
    for (const [k, v] of big5Reverse) {
        if (v === -1) {
            big5Reverse.delete(k);
        }
    }
    return big5Reverse;
}

/**
 * 把「Big5 字节被当 GBK 解码」的乱码还原回繁体原文（如 `狶古` → `林宥嘉`）。
 *
 * Big5 与 GBK 的字节空间 100% 重叠，单看字节无法区分；但真 Big5 乱码必然落在
 * GBK 的偏僻区（CJK 兼容区、注音、私有区、控制符），正常简体字很少落到那里。
 * 因此以 `RE_BIG5_SUSPECT` 为门控：只有已判为可疑的文本才尝试还原。
 * 实测在 8.8 万个字段上仅改动 12 处（全为真 Big5），不加门控则会误改 3.5 万处。
 */
function repairBig5Mojibake(text: string): string {
    if (!RE_BIG5_SUSPECT.test(text)) {
        return text;
    }
    const rev = getBig5Reverse();
    const bytes: number[] = [];
    for (const ch of text) {
        const b = rev.get(ch);
        if (b === undefined) {
            return text; // 有字符不在表内，还原必不完整
        }
        bytes.push(b >> 8, b & 0xff);
    }
    const fixed = new TextDecoder('big5').decode(Buffer.from(bytes));
    return !RE_BAD_TEXT.test(fixed) && RE_CJK.test(fixed) ? fixed : text;
}

/**
 * 解码一段 ID3 文本：优先严格 UTF-8，失败则退回 GB18030（兼容 GBK/GB2312），
 * 依次尝试还原「GBK 字节被当 ISO-8859-1」与「Big5 字节被当 GBK」两类乱码。
 * ponytail: 单个汉字有约 9% 概率恰好是合法 UTF-8，可能解出乱码；
 *            真实多字文本概率约 0，不值得为此引入编码检测库。
 * @returns 解码结果与实测编码：utf8 / gbk / latin1乱码还原 / big5乱码还原
 */
function decodeText(buf: Buffer): { text: string; enc: string } {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    try {
        const text = strictUtf8.decode(bytes);
        // 声明 UTF-8 但实际塞的是「GBK 字节被当 ISO-8859-1」的乱码（如 `Ã«°¢Ãô`）：
        // 严格 UTF-8 恰好能解出这些单字节西文字符，再按 latin1→GBK 还原一次。
        // 正常中文/英文串还原结果不变或含 CJK 不达标，不会误伤。
        const l1 = repairLatin1Mojibake(text);
        return l1 === text ? { text, enc: 'utf8' } : { text: l1, enc: 'latin1乱码还原' };
    } catch {
        // gb18030 解码器遇非法字节不抛错，只吐 U+FFFD——故用解码结果 + 修复兜底
        const gb = gb18030.decode(bytes);
        const l1 = repairLatin1Mojibake(gb);
        if (l1 !== gb) {
            return { text: l1, enc: 'latin1乱码还原' };
        }
        const b5 = repairBig5Mojibake(l1);
        if (b5 !== l1) {
            return { text: b5, enc: 'big5乱码还原' };
        }
        return { text: b5, enc: 'gbk' };
    }
}

/** 按 ID3v2 的编码字节解码帧内容（已去掉首字节编码标识） */
function decodeFrameText(encoding: number, body: Buffer): { text: string; enc: string } {
    if (encoding === 1) {
        // UTF-16 带 BOM：BOM 决定字节序，无 BOM 时按 LE 处理（Node 的 utf-16le 为默认实现）
        let text: string;
        if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
            text = body.subarray(2).swap16().toString('utf16le');
        } else if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
            text = body.subarray(2).toString('utf16le');
        } else {
            text = body.toString('utf16le');
        }
        return { text, enc: 'utf16' };
    }
    if (encoding === 2) {
        return { text: body.swap16().toString('utf16le'), enc: 'utf16' };
    }
    if (encoding === 3) {
        // 声明 UTF-8：交给 decodeText 探测（其内部同样会还原声明 UTF-8 却实为 latin1 乱码的情况，
        // 并把还原结果标成 latin1乱码还原——不能强制标 utf8，否则 --update 不会写回这些文件）
        return decodeText(body);
    }
    // encoding 0（含历史遗留的 GBK 误标）：走 UTF-8/GB18030 探测
    return decodeText(body);
}

/** 去掉尾部填充的 0 字节与首尾空白 */
function tidy(text: string): string {
    return sanitize(text.replace(/\u0000+$/, '').trim());
}

/** 部分老打标工具在字段为空时会写入字面文本 "null"/"undefined"，视为无效值 */
function sanitize(text: string): string {
    return /^(null|undefined)$/i.test(text) ? '' : text;
}

/**
 * 超过 MAX_FIELD_CHARS 个码点时截取（按码点，避免在代理对中间截断产生 U+FFFD）。
 */
function truncate(text: string): string {
    const chars = [...text];
    return chars.length > MAX_FIELD_CHARS ? chars.slice(0, MAX_FIELD_CHARS).join('') : text;
}

/** 将毫秒格式化为 时长字符串（mm:ss / hh:mm:ss / d天 hh:mm:ss） */
function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (d > 0) {
        return `${d}天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    if (h > 0) {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
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

/** 读取 ID3v2 标签，返回 标签帧 Map、编码 Map 与音频数据起始偏移 (audioStart) */
function readId3v2(buf: Buffer): {
    tags: Map<string, string>;
    tagEnc: Map<string, string>;
    commLang: Map<string, string>;
    rawFrames: Buffer[];
    audioStart: number;
    tagBodyLen: number;
    hasV2: boolean;
} {
    const tags = new Map<string, string>();
    const tagEnc = new Map<string, string>();
    const commLang = new Map<string, string>();
    const rawFrames: Buffer[] = [];
    if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') {
        return { tags, tagEnc, commLang, rawFrames, audioStart: 0, tagBodyLen: 0, hasV2: false };
    }

    const major = buf[3];
    const flags = buf[5];
    const synchsafe = (o: number): number =>
        ((buf[o] & 0x7f) << 21) | ((buf[o + 1] & 0x7f) << 14) | ((buf[o + 2] & 0x7f) << 7) | (buf[o + 3] & 0x7f);
    let tagSize = synchsafe(6);
    let tagEnd = Math.min(10 + tagSize, buf.length);

    // 整个标签做了非同步处理：0xFF 0x00 还原为 0xFF
    if (flags & 0x80) {
        const start = 10;
        const out = Buffer.alloc(tagEnd - start);
        let w = 0;
        for (let r = start; r < tagEnd; r++) {
            out[w++] = buf[r];
            if (buf[r] === 0xff && buf[r + 1] === 0x00) {
                r++;
            }
        }
        // 去同步后标签变短，重新拼成 [头部 + 去同步后的标签][音频数据]
        tagEnd = start + w;
        tagSize = w;
        buf = Buffer.concat([buf.subarray(0, start), out.subarray(0, w), buf.subarray(start + synchsafe(6))]);
    }

    // 扩展头时跳过（v2.3 为 4 字节长度，v2.4 为 4 字节 synchsafe 长度）
    let pos = 10;
    if (flags & 0x40) {
        if (pos + 4 <= tagEnd) {
            const extSize = major >= 4 ? synchsafe(pos) : buf.readUInt32BE(pos);
            pos += major >= 4 ? extSize : extSize + 4;
        }
    }

    const idLen = major <= 2 ? 3 : 4;
    const headerLen = major <= 2 ? 6 : 10;

    while (pos + headerLen <= Math.min(10 + tagSize, buf.length)) {
        const rawId = buf.toString('latin1', pos, pos + idLen);
        if (!/^[A-Z0-9]{3,4}$/.test(rawId)) {
            break; // 帧区域结束（遇到填充 0 或音频数据）
        }
        const id = major <= 2 ? (V22_FRAME_IDS[rawId] ?? rawId) : rawId;
        let frameSize: number;
        let frameFlags = 0;
        if (major <= 2) {
            frameSize = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
        } else if (major === 3) {
            frameSize = buf.readUInt32BE(pos + 4);
            frameFlags = buf.readUInt16BE(pos + 8);
        } else {
            frameSize = synchsafe(pos + 4);
            frameFlags = buf.readUInt16BE(pos + 8);
        }
        const bodyStart = pos + headerLen;
        const bodyEnd = bodyStart + frameSize;
        // 零长帧是合法的（正文为空），保留帧头继续往后读；越界则说明帧区到此为止
        if (bodyEnd > buf.length) {
            break;
        }
        // 压缩/加密/分组帧无法直接解码文本，跳过（原始字节仍保留）
        // v2.2 的帧在这里就转成 v2.3 形态（4 字符 ID + 10 字节头）再存：
        // 写回路径按 4 字符头解析，原样保存的话 ID 会取到长度字段、正文会错位 4 字节
        if (major <= 2) {
            const mapped = V22_FRAME_IDS[rawId];
            if (mapped) {
                const h = Buffer.alloc(10);
                h.write(mapped, 0, 'latin1');
                h.writeUInt32BE(frameSize, 4);
                rawFrames.push(Buffer.concat([h, buf.subarray(bodyStart, bodyEnd)]));
            }
        } else {
            rawFrames.push(buf.subarray(pos, bodyEnd));
        }
        if (!(frameFlags & 0x00c0)) {
            const body = buf.subarray(bodyStart, bodyEnd);
            if (id === 'TXXX') {
                // TXXX：描述 + 值，编码字节后是两个以 0 结尾的文本
                const enc = body[0];
                const rest = body.subarray(1);
                const sepLen = enc === 1 || enc === 2 ? 2 : 1;
                let sep = -1;
                for (let i = 0; i + sepLen <= rest.length; i += sepLen) {
                    if (rest[i] === 0 && (sepLen === 1 || rest[i + 1] === 0)) {
                        sep = i;
                        break;
                    }
                }
                if (sep >= 0) {
                    const d = decodeFrameText(enc, rest.subarray(0, sep));
                    const v = decodeFrameText(enc, rest.subarray(sep + sepLen));
                    const desc = tidy(d.text);
                    const value = tidy(v.text);
                    if (value) {
                        tags.set(`TXXX:${desc.toUpperCase()}`, value);
                        tagEnc.set(`TXXX:${desc.toUpperCase()}`, v.enc);
                    }
                }
            } else if (id.startsWith('T') && id !== 'TXXX') {
                const d = decodeFrameText(body[0], body.subarray(1));
                const value = tidy(d.text);
                if (value) {
                    tags.set(id, value);
                    tagEnc.set(id, d.enc);
                }
            } else if (id === 'COMM' || id === 'COM') {
                // 注释：编码字节 + 3 字节语言 + 描述(0 结尾) + 正文
                const enc = body[0];
                const sepLen = enc === 1 || enc === 2 ? 2 : 1;
                const rest = body.subarray(4);
                let sep = -1;
                for (let i = 0; i + sepLen <= rest.length; i += sepLen) {
                    if (rest[i] === 0 && (sepLen === 1 || rest[i + 1] === 0)) {
                        sep = i;
                        break;
                    }
                }
                if (sep >= 0) {
                    const d = decodeFrameText(enc, rest.subarray(sep + sepLen));
                    const value = tidy(d.text);
                    if (value) {
                        tags.set('COMM', value);
                        tagEnc.set('COMM', d.enc);
                        commLang.set('COMM', body.toString('latin1', 1, 4));
                    }
                }
            }
        }
        pos = bodyEnd;
    }

    // 音频数据从帧区域停止处开始（帧循环正常走完时即标签末尾）
    // tagBodyLen 取帧区实际长度（不含原填充）：写回时按它补足填充，
    // 若用头部声明的 tagSize（已含填充）会把填充算两遍、把音频推后
    return { tags, tagEnc, commLang, rawFrames, audioStart: pos, tagBodyLen: pos - 10, hasV2: true };
}

/** MPEG 版本/层 → 每帧采样数 */
const SAMPLES_PER_FRAME: Record<string, number> = {
    '1-1': 384,
    '1-2': 1152,
    '1-3': 1152,
    '2-1': 384,
    '2-2': 1152,
    '2-3': 576,
    '2.5-1': 384,
    '2.5-2': 1152,
    '2.5-3': 576,
};

const BITRATE_TABLE: Record<string, number[]> = {
    '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATE_TABLE: Record<string, number[]> = {
    '1': [44100, 48000, 32000],
    '2': [22050, 24000, 16000],
    '2.5': [11025, 12000, 8000],
};

const CHANNEL_MODES = ['立体声', '联合立体声', '双声道', '单声道'];

interface AudioInfo {
    bitrateKbps: number;
    sampleRate: number;
    channels: string;
    durationMs: number;
    /** 音频中出现的不同码率值（判断 CBR/VBR 用） */
    bitrateSet: Set<number>;
}

/**
 * 定位并解析第一帧音频头，逐帧统计时长。
 * 时长按帧累加 samples/sampleRate 得到，VBR 文件同样正确。
 */
function readAudio(buf: Buffer, start: number): AudioInfo | null {
    let pos = start;
    const end = buf.length;

    while (pos + 4 <= end) {
        // 帧同步：11 个 1
        if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) {
            pos++;
            continue;
        }
        const b1 = buf[pos + 1];
        const b2 = buf[pos + 2];
        const versionBits = (b1 & 0x18) >> 3;
        const layerBits = (b1 & 0x06) >> 1;
        if (versionBits === 1 || layerBits === 0) {
            pos++; // 保留位，非法
            continue;
        }
        const version = ['2.5', 'x', '2', '1'][versionBits];
        const layer = [null, 3, 2, 1][layerBits] as number;
        const bitrateIdx = (b2 & 0xf0) >> 4;
        const sampleRateIdx = (b2 & 0x0c) >> 2;
        if (bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) {
            pos++;
            continue;
        }
        const simpleVersion = version === '2.5' ? '2' : version;
        const key = `${simpleVersion}-${layer}`;
        const bitrate = BITRATE_TABLE[key]?.[bitrateIdx] ?? 0;
        const sampleRate = SAMPLE_RATE_TABLE[version]?.[sampleRateIdx] ?? 0;
        const samples = SAMPLES_PER_FRAME[key] ?? 0;
        if (!bitrate || !sampleRate || !samples) {
            pos++;
            continue;
        }
        const padding = (b2 & 0x02) >> 1;
        const frameSize =
            layer === 1
                ? Math.floor((samples * bitrate * 125) / sampleRate + padding * 4)
                : Math.floor((samples * bitrate * 125) / sampleRate + padding);
        if (frameSize < 4) {
            pos++;
            continue;
        }

        // 找到首个合法帧：自此处逐帧遍历统计
        const bitrateSet = new Set<number>();
        let durationMs = 0;
        let cur = pos;
        while (cur + 4 <= end) {
            const c1 = buf[cur + 1];
            const c2 = buf[cur + 2];
            if (buf[cur] !== 0xff || (c1 & 0xe0) !== 0xe0) {
                break; // 帧序列结束（遇到尾部的 ID3v1 或其他数据）
            }
            const cVersionBits = (c1 & 0x18) >> 3;
            const cLayerBits = (c1 & 0x06) >> 1;
            const cBitrateIdx = (c2 & 0xf0) >> 4;
            const cSampleRateIdx = (c2 & 0x0c) >> 2;
            if (cVersionBits === 1 || cLayerBits === 0 || cBitrateIdx === 0 || cBitrateIdx === 15 || cSampleRateIdx === 3) {
                break;
            }
            const cVersion = ['2.5', 'x', '2', '1'][cVersionBits];
            const cLayer = [null, 3, 2, 1][cLayerBits] as number;
            const cSimpleVersion = cVersion === '2.5' ? '2' : cVersion;
            const cKey = `${cSimpleVersion}-${cLayer}`;
            const cBitrate = BITRATE_TABLE[cKey]?.[cBitrateIdx] ?? 0;
            const cSampleRate = SAMPLE_RATE_TABLE[cVersion]?.[cSampleRateIdx] ?? 0;
            const cSamples = SAMPLES_PER_FRAME[cKey] ?? 0;
            if (!cBitrate || !cSampleRate || !cSamples) {
                break;
            }
            const cPadding = (c2 & 0x02) >> 1;
            const cFrameSize =
                cLayer === 1
                    ? Math.floor((cSamples * cBitrate * 125) / cSampleRate + cPadding * 4)
                    : Math.floor((cSamples * cBitrate * 125) / cSampleRate + cPadding);
            if (cFrameSize < 4) {
                break;
            }
            bitrateSet.add(cBitrate);
            durationMs += (cSamples / cSampleRate) * 1000;
            cur += cFrameSize;
        }

        return {
            bitrateKbps: bitrate,
            sampleRate,
            channels: CHANNEL_MODES[(buf[pos + 3] & 0xc0) >> 6],
            durationMs,
            bitrateSet,
        };
    }

    return null;
}

/** 读取文件末尾 128 字节的 ID3v1 标签（无 ID3v2 时的兜底），文本按 UTF-8/GB18030 探测解码 */
function readId3v1(buf: Buffer): { tags: Map<string, string>; tagEnc: Map<string, string> } {
    const tags = new Map<string, string>();
    const tagEnc = new Map<string, string>();
    if (buf.length < 128) {
        return { tags, tagEnc };
    }
    const tail = buf.subarray(buf.length - 128);
    if (tail.toString('latin1', 0, 3) !== 'TAG') {
        return { tags, tagEnc };
    }
    const field = (start: number, len: number): { text: string; enc: string } => {
        const d = decodeText(tail.subarray(start, start + len));
        return { text: tidy(d.text), enc: d.enc };
    };
    const title = field(3, 30);
    const artist = field(33, 30);
    const album = field(63, 30);
    const year = field(93, 4);
    if (title.text) {
        tags.set('TIT2', title.text);
        tagEnc.set('TIT2', title.enc);
    }
    if (artist.text) {
        tags.set('TPE1', artist.text);
        tagEnc.set('TPE1', artist.enc);
    }
    if (album.text) {
        tags.set('TALB', album.text);
        tagEnc.set('TALB', album.enc);
    }
    if (year.text) {
        tags.set('TYER', year.text);
        tagEnc.set('TYER', year.enc);
    }
    const genreIdx = tail[127];
    if (genreIdx !== 255) {
        const g = ID3V1_GENRES[genreIdx] ?? String(genreIdx);
        tags.set('TCON', g);
        tagEnc.set('TCON', 'gbk'); // ID3v1 流派是编号查表，非文本编码
    }
    return { tags, tagEnc };
}

/** ID3v1 流派编号表（0-79 为 ID3v1 标准，其后为 Winamp 扩展） */
const ID3V1_GENRES = [
    'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop',
    'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap',
    'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks',
    'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance',
    'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
    'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock',
    'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream',
    'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle',
    'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi',
    'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

/**
 * 把 TCON 里的流派编号换成流派名：支持 "17"、"(17)"，以及 v2.3 的连续形式 "(17)(20)"。
 * 任一编号不在表内时保留原始文本。
 */
function normalizeGenre(raw: string): string {
    const parts = raw.match(/\(?\d{1,3}\)?/g);
    if (!parts || parts.join('') !== raw) {
        return raw; // 含非编号内容（如 "Rock"、"Rock/Pop"），原样返回
    }
    return parts
        .map((p) => {
            const idx = Number(p.replace(/[()]/g, ''));
            return ID3V1_GENRES[idx] ?? p;
        })
        .join('/');
}

/** 递归收集目录下所有 .mp3 文件的绝对路径 */
function listMp3Files(root: string): string[] {
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
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp3')) {
                files.push(full);
            }
        }
    }
    return files;
}

/** 解析单个 mp3 文件，返回其信息与写回所需数据；文件无法读取或非合法 mp3 时返回 null */
function readMp3(file: string, root: string): ParsedMp3 | null {
    const buf = fs.readFileSync(file);
    const v2 = readId3v2(buf);
    const tags = v2.tags;
    const tagEnc = v2.tagEnc;
    const commLang = v2.commLang;
    // v1 只作兜底：v2 已有年份（TYER 或 TDRC）时不要用 v1 的 TYER 覆盖，
    // 否则 yearEnc 会取到 v1 的兜底编码 gbk，把已转码成 TDRC 的文件误判成需要写回
    const hasYearTag = tags.has('TYER') || tags.has('TDRC');
    if (tags.size === 0) {
        const v1 = readId3v1(buf);
        for (const [k, v] of v1.tags) {
            if (k === 'TYER' && hasYearTag) {
                continue;
            }
            if (!tags.has(k)) {
                tags.set(k, v);
                tagEnc.set(k, v1.tagEnc.get(k) ?? 'gbk');
            }
        }
    }
    const audio = readAudio(buf, v2.audioStart);
    if (!audio) {
        return null;
    }

    const genreRaw = tags.get('TCON') ?? tags.get('TXXX:GENRE') ?? tags.get('TXXX:流派') ?? '';
    const genreEnc = tagEnc.get('TCON') ?? tagEnc.get('TXXX:GENRE') ?? tagEnc.get('TXXX:流派') ?? 'gbk';
    const genre = normalizeGenre(genreRaw);
    const tag = (key: string): string => truncate(tags.get(key) ?? '');
    const enc = (key: string): string => tagEnc.get(key) ?? 'gbk';

    // 任一非空字段的编码不是 utf8 → 需要写回（空字段的 gbk 兜底不算变化）
    let changed = false;
    for (const [k, e] of tagEnc) {
        if (e !== 'utf8' && tags.get(k)) {
            changed = true;
            break;
        }
    }

    const info: Mp3Info = {
        name: path.basename(file),
        path: path.relative(root, file),
        size: utils.formatMemory(buf.length),
        id3Version: v2.hasV2 ? `ID3v2.${buf[3]}` : tags.size > 0 ? 'ID3v1' : '无',
        id3Changed: changed,
        title: tag('TIT2'),
        titleEnc: enc('TIT2'),
        artist: tag('TPE1'),
        artistEnc: enc('TPE1'),
        album: tag('TALB'),
        albumEnc: enc('TALB'),
        year: tag('TYER') || tag('TDRC'),
        // 用 ?? 而非 ||：v1 兜底会把 TYER 的编码填进来，但 v2.4 文件里年份实际在 TDRC
        yearEnc: tag('TYER') ? enc('TYER') : enc('TDRC'),
        genre: truncate(genre),
        genreEnc,
        bitrate: `${audio.bitrateKbps} kbps${audio.bitrateSet.size > 1 ? ' (VBR)' : ''}`,
        duration: formatDuration(audio.durationMs),
        durationMs: audio.durationMs,
        sampleRate: `${audio.sampleRate} Hz`,
        channel: audio.channels,
    };
    return {
        info,
        tags,
        tagEnc,
        commLang,
        rawFrames: v2.rawFrames,
        tagBodyLen: v2.tagBodyLen,
        audioStart: v2.audioStart,
        buf,
        changed,
    };
}

/** 把 4 字节长度写成 ID3v2.4 的 synchsafe 形式（每字节只用低 7 位） */
function synchsafe(value: number): Buffer {
    return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

/** 构造一个普通 UTF-8 文本帧（编码字节 3 + 文本，无描述字段） */
function buildTextFrame(id: string, text: string): Buffer {
    const body = Buffer.concat([Buffer.from('\x03', 'latin1'), Buffer.from(text, 'utf8')]);
    return Buffer.concat([Buffer.from(id, 'latin1'), synchsafe(body.length), Buffer.from([0, 0]), body]);
}

/** 构造 TXXX 帧（编码字节 3 + 描述 + 0 分隔 + 值） */
function buildTxxxFrame(desc: string, value: string): Buffer {
    const body = Buffer.concat([Buffer.from('\x03', 'latin1'), Buffer.from(`${desc}\x00`, 'utf8'), Buffer.from(value, 'utf8')]);
    return Buffer.concat([Buffer.from('TXXX', 'latin1'), synchsafe(body.length), Buffer.from([0, 0]), body]);
}

/** 构造 COMM 帧（编码字节 3 + 语言码 + 空描述 + 正文） */
function buildCommFrame(text: string, lang: string): Buffer {
    const body = Buffer.concat([Buffer.from('\x03', 'latin1'), Buffer.from(lang, 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf8')]);
    return Buffer.concat([Buffer.from('COMM', 'latin1'), synchsafe(body.length), Buffer.from([0, 0]), body]);
}

/**
 * 需要重新生成的帧：文本帧（含 TXXX）、注释帧，以及 v2.3 里已被 v2.4 废弃的日期帧。
 * 其余帧（封面 APIC、歌词 USLT、TRCK、TPE2……）一律按原字节保留，绝不丢弃。
 */
function isRewrittenFrame(id: string): boolean {
    if (id === 'TXXX' || id === 'COMM' || id === 'COM') {
        return true;
    }
    if (id[0] === 'T') {
        return true;
    }
    // v2.4 已废弃：年月日合并进 TDRC，播放列表改由 TXXX:PLAYLIST 之类承载
    return id === 'TDAT' || id === 'TIME' || id === 'TORY' || id === 'TRDA';
}

/** 取一帧的 4 字符 ID 与正文（rawFrames 里的帧一律已是 10 字节头的 v2.3/2.4 形态） */
function splitFrame(frame: Buffer): { id: string; body: Buffer } {
    const id = frame.toString('latin1', 0, 4);
    return { id, body: frame.subarray(10) };
}

/**
 * 按需转码的帧 → 新的 UTF-8 帧字节。
 * 解不出文本时（空值 / 工具不认识），退回按原字节保留而不是丢弃：宁可留一帧没转码的旧编码，
 * 也不让标签内容凭空少一块。
 */
function rebuildFrame(id: string, body: Buffer, raw: Buffer, p: ParsedMp3): Buffer {
    if (id === 'TXXX') {
        const { id: desc, body: value } = splitTxxx(body, p);
        if (value) {
            return buildTxxxFrame(desc, value);
        }
    } else if (id === 'COMM' || id === 'COM') {
        const text = p.tags.get('COMM');
        if (text) {
            return buildCommFrame(text, p.commLang.get('COMM') ?? 'XXX');
        }
    } else if (id === 'TYER' || id === 'TDRC') {
        // v2.4 里年份统一写 TDRC，不再写 TYER
        const year = p.tags.get('TYER') ?? p.tags.get('TDRC');
        if (year) {
            return buildTextFrame('TDRC', year);
        }
    } else if (id[0] === 'T') {
        const text = p.tags.get(id);
        if (text) {
            return buildTextFrame(id, text);
        }
    }
    return reframeToV24(raw);
}

/**
 * 拆出 TXXX 的描述与值（描述在 readId3v2 里已连同值一起存进 tags）。
 * 畸形帧（没有 0 分隔符）时退回用整段正文当值、描述留空，避免整帧被静默丢掉。
 */
function splitTxxx(body: Buffer, p: ParsedMp3): { id: string; body: string } {
    const enc = body[0];
    const sepLen = enc === 1 || enc === 2 ? 2 : 1;
    const rest = body.subarray(1);
    let sep = -1;
    for (let i = 0; i + sepLen <= rest.length; i += sepLen) {
        if (rest[i] === 0 && (sepLen === 1 || rest[i + 1] === 0)) {
            sep = i;
            break;
        }
    }
    if (sep < 0) {
        return { id: '', body: tidy(decodeFrameText(enc, rest).text) };
    }
    const desc = tidy(decodeFrameText(enc, rest.subarray(0, sep)).text).toUpperCase();
    return { id: desc, body: p.tags.get(`TXXX:${desc}`) ?? '' };
}

/** 把一帧的帧头改写成 ID3v2.4 形式（synchsafe 长度），正文不动 */
function reframeToV24(frame: Buffer): Buffer {
    return Buffer.concat([frame.subarray(0, 4), synchsafe(frame.length - 10), Buffer.from([0, 0]), frame.subarray(10)]);
}

/**
 * 把标签写回文件：升级为 ID3v2.4 + UTF-8，并丢弃尾部旧的 ID3v1 标签。
 * 原标签里工具未解码的帧（封面 APIC、歌词 USLT、TRCK 等）按原字节保留，只重建需转码的文本帧；
 * 转码后标签正文变长时不做裁剪（帧一个都不能丢），此时音频数据整体后移。
 * 失败时原文件不受影响（先写临时文件再 rename）。
 */
function writeId3v24(file: string, p: ParsedMp3): void {
    const frames: Buffer[] = [];
    const emitted = new Set<string>();
    for (const raw of p.rawFrames) {
        const { id, body } = splitFrame(raw);
        if (!isRewrittenFrame(id)) {
            // 原帧只改帧头：v2.3 的长度是普通大端，v2.4 要 synchsafe
            frames.push(reframeToV24(raw));
            emitted.add(id);
            continue;
        }
        frames.push(rebuildFrame(id, body, raw, p));
        emitted.add(id);
    }
    // 只有 ID3v1 的文件：原标签没有任何帧可保留，用解码出的字段补出对应的 v2 帧
    const hasYear = emitted.has('TYER') || emitted.has('TDRC');
    for (const [k, v] of p.tags) {
        if (!v || emitted.has(k)) {
            continue;
        }
        let frame: Buffer | null = null;
        if (k.startsWith('TXXX:')) {
            frame = buildTxxxFrame(k.slice(5), v);
        } else if (k === 'COMM') {
            frame = buildCommFrame(v, p.commLang.get('COMM') ?? 'XXX');
        } else if (k === 'TYER' || k === 'TDRC') {
            frame = hasYear ? null : buildTextFrame('TDRC', v);
            emitted.add('TDRC');
        } else if (k[0] === 'T') {
            frame = buildTextFrame(k, v);
        }
        if (frame) {
            frames.push(frame);
            emitted.add(k);
        }
    }
    // 帧区变短时补 0 保持原长度；变长则直接超出（音频后移，但音频字节本身在下面显式裁剪保留）
    let used = 0;
    for (const f of frames) {
        used += f.length;
    }
    const body = Buffer.concat([...frames, Buffer.alloc(Math.max(0, p.tagBodyLen - used))]);
    const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), synchsafe(body.length)]);

    // 丢弃尾部 ID3v1（TAG 开头 128 字节），避免新旧两套标签并存
    let audioEnd = p.buf.length;
    if (audioEnd >= 128 && p.buf.toString('latin1', audioEnd - 128, audioEnd - 125) === 'TAG') {
        audioEnd -= 128;
    }
    const tmp = `${file}.tmp-mp3info`;
    fs.writeFileSync(tmp, Buffer.concat([header, body, p.buf.subarray(p.audioStart, audioEnd)]));
    fs.chmodSync(tmp, fs.statSync(file).mode);
    fs.renameSync(tmp, file); // 原子覆盖
}

function main(): void {
    const argv = process.argv.slice(2);
    const update = argv.includes('--update');
    const target = argv.find((a) => a !== '--update');
    if (!target) {
        console.error('用法: node mp3info.js <目录路径> [--update]');
        process.exit(1);
    }
    const absTarget = path.resolve(target);
    if (!fs.existsSync(absTarget) || !fs.statSync(absTarget).isDirectory()) {
        console.error(`错误: 目录不存在或不是目录: ${absTarget}`);
        process.exit(1);
    }

    const files = listMp3Files(absTarget).sort();
    const infos: Mp3Info[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const noTags: Array<{ path: string; id3Version: string }> = [];

    const totalCount = files.length;
    const startTime = Date.now();
    let lastRender = 0;
    const panel = new ProgressPanel();
    let processed = 0;

    for (const file of files) {
        processed++;
        const rel = path.relative(absTarget, file);
        try {
            const parsed = readMp3(file, absTarget);
            if (!parsed) {
                console.warn(`跳过（未识别到音频帧）: ${rel}`);
                skipped.push({ path: rel, reason: '未识别到合法的 MPEG 音频帧' });
            } else {
                if (parsed.info.id3Version === '无') {
                    noTags.push({ path: parsed.info.path, id3Version: parsed.info.id3Version });
                }
                if (update && parsed.changed) {
                    try {
                        writeId3v24(file, parsed);
                        parsed.info.id3Version = 'ID3v2.4'; // 文件现在确实是 v2.4
                    } catch (err) {
                        parsed.info.id3Changed = false; // 没写成功 = 未变化
                        skipped.push({ path: rel, reason: `更新失败: ${(err as Error).message}` });
                    }
                }
                infos.push(parsed.info);
            }
        } catch (err) {
            console.warn(`跳过（读取失败）: ${rel} (${(err as Error).message})`);
            skipped.push({ path: rel, reason: `读取失败: ${(err as Error).message}` });
        }

        const now = Date.now();
        const isLast = processed === totalCount;
        // 节流：最多每 80ms 刷新一次面板，最后一个文件必刷
        if (isLast || now - lastRender >= 80) {
            lastRender = now;
            const percent = totalCount === 0 ? 100 : (processed / totalCount) * 100;
            panel.render([
                `当前处理: ${rel}`,
                `进度条  : ${renderBar(percent)} ${percent.toFixed(1).padStart(5)}%`,
                `文件数  : ${processed}/${totalCount} (${percent.toFixed(1)}%)`,
                `耗时    : ${formatDuration(now - startTime)}`,
            ]);
        }
    }

    // 汇总统计
    const sumMs = infos.reduce((acc, f) => acc + f.durationMs, 0);
    const encCount: Record<string, number> = {};
    for (const f of infos) {
        for (const e of [f.titleEnc, f.artistEnc, f.albumEnc, f.yearEnc, f.genreEnc]) {
            encCount[e] = (encCount[e] ?? 0) + 1;
        }
    }
    const vbr = infos.filter((f) => f.bitrate.includes('VBR')).length;
    const noTag = noTags.length;
    const changed = infos.filter((f) => f.id3Changed).length;

    const result: Mp3InfoResult = {
        path: absTarget,
        files: infos,
        skipped,
        noTags,
        total: {
            fileCount: infos.length,
            skippedCount: skipped.length,
            noTagCount: noTag,
            changedCount: changed,
            unchangedCount: infos.length - changed,
            totalDuration: formatDuration(sumMs),
            vbrCount: vbr,
            encCount,
        },
    };
    const outFile = path.resolve(`mp3info-result-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(
        `处理完成，共扫描 ${infos.length} 个，跳过 ${skipped.length} 个，无 ID3 标签 ${noTag} 个，` +
            `ID3 ${update ? '已更新' : '有变化'} ${changed} 个 / 未变化 ${infos.length - changed} 个，` +
            `总时长 ${formatDuration(sumMs)}，VBR ${vbr} 个，耗时 ${formatDuration(Date.now() - startTime)}，结果已保存到: ${outFile}`
    );
}

main();

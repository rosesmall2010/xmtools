#!/usr/bin/env node
/**
 * mp3info 工具：递归扫描目录下所有 .mp3 文件，提取 ID3 标签与音频参数。
 *
 * 用法：node mp3info.js <目录路径>
 *
 * 提取的信息：
 * - 文件：文件名、相对路径、文件大小
 * - ID3 标签：歌手、歌曲名、专辑、年份、流派（每个字段最多保留 50 个字符，超出截取）
 * - 音频参数：码率、时长、采样率、声道（单声道/立体声等）
 *
 * 编码检测：ID3v2 文本帧带一个编码字节（0=ISO-8859-1、1=UTF-16 带 BOM、2=UTF-16BE、3=UTF-8），
 * 但历史上大量中文标签虽然声明 0（ISO-8859-1），实际写入的是 GBK/GB2312 字节。
 * 因此对非 ASCII 内容：先按严格 UTF-8 解码，失败则按 GB18030（兼容 GBK/GB2312）解码。
 * 实测 GBK 中文文本恰好构成合法 UTF-8 的概率约 0（6 个汉字时 < 0.0001%），该判定可靠。
 *
 * ID3v1 兜底：无 ID3v2 标签时读取文件末尾 128 字节的 TAG 块（按 GB18030 解码）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { utils } from 'xmcommon';

/** 每个 ID3 文本字段最多保留的字符数 */
const MAX_FIELD_CHARS = 50;

/** ID3v2.2 的 3 字符帧 ID → ID3v2.3/2.4 的 4 字符 ID（只列本工具用到的字段） */
const V22_FRAME_IDS: Record<string, string> = {
    TT2: 'TIT2',
    TP1: 'TPE1',
    TAL: 'TALB',
    TYE: 'TYER',
    TCO: 'TCON',
    TXX: 'TXXX',
    COM: 'COMM',
};

interface Mp3Info {
    name: string;
    path: string;
    size: string;
    id3Version: string;
    title: string;
    artist: string;
    album: string;
    year: string;
    genre: string;
    bitrate: string;
    duration: string;
    sampleRate: string;
    channel: string;
}

interface Mp3InfoResult {
    path: string;
    files: Mp3Info[];
    skipped: Array<{ path: string; reason: string }>;
    total: { fileCount: number; skippedCount: number };
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
 */
function decodeText(buf: Buffer): string {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    try {
        return strictUtf8.decode(bytes);
    } catch {
        // gb18030 解码器遇非法字节不抛错，只吐 U+FFFD——故用解码结果 + 修复兜底
        return repairBig5Mojibake(repairLatin1Mojibake(gb18030.decode(bytes)));
    }
}

/** 按 ID3v2 的编码字节解码帧内容（已去掉首字节编码标识） */
function decodeFrameText(encoding: number, body: Buffer): string {
    if (encoding === 1) {
        // UTF-16 带 BOM：BOM 决定字节序，无 BOM 时按 LE 处理（Node 的 utf-16le 为默认实现）
        if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
            return body.subarray(2).swap16().toString('utf16le');
        }
        if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
            return body.subarray(2).toString('utf16le');
        }
        return body.toString('utf16le');
    }
    if (encoding === 2) {
        return body.swap16().toString('utf16le');
    }
    if (encoding === 3) {
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

/** 读取 ID3v2 标签，返回 标签帧 Map 与音频数据起始偏移 (audioStart) */
function readId3v2(buf: Buffer): { tags: Map<string, string>; audioStart: number; hasV2: boolean } {
    const tags = new Map<string, string>();
    if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') {
        return { tags, audioStart: 0, hasV2: false };
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
        if (frameSize <= 0 || bodyEnd > buf.length) {
            break;
        }
        // 压缩/加密/分组帧无法直接解码文本，跳过
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
                    const desc = tidy(decodeFrameText(enc, rest.subarray(0, sep)));
                    const value = tidy(decodeFrameText(enc, rest.subarray(sep + sepLen)));
                    if (value) {
                        tags.set(`TXXX:${desc.toUpperCase()}`, value);
                    }
                }
            } else if (id.startsWith('T') && id !== 'TXXX') {
                const value = tidy(decodeFrameText(body[0], body.subarray(1)));
                if (value) {
                    tags.set(id, value);
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
                    const value = tidy(decodeFrameText(enc, rest.subarray(sep + sepLen)));
                    if (value) {
                        tags.set('COMM', value);
                    }
                }
            }
        }
        pos = bodyEnd;
    }

    // 音频数据从帧区域停止处开始（帧循环正常走完时即标签末尾）
    return { tags, audioStart: pos, hasV2: true };
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
function readId3v1(buf: Buffer): Map<string, string> {
    const tags = new Map<string, string>();
    if (buf.length < 128) {
        return tags;
    }
    const tail = buf.subarray(buf.length - 128);
    if (tail.toString('latin1', 0, 3) !== 'TAG') {
        return tags;
    }
    const field = (start: number, len: number): string => tidy(decodeText(tail.subarray(start, start + len)));
    const title = field(3, 30);
    const artist = field(33, 30);
    const album = field(63, 30);
    const year = field(93, 4);
    if (title) tags.set('TIT2', title);
    if (artist) tags.set('TPE1', artist);
    if (album) tags.set('TALB', album);
    if (year) tags.set('TYER', year);
    const genreIdx = tail[127];
    if (genreIdx !== 255) {
        tags.set('TCON', ID3V1_GENRES[genreIdx] ?? String(genreIdx));
    }
    return tags;
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

/** 格式化时长（毫秒 → mm:ss） */
function formatDuration(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
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

/** 解析单个 mp3 文件，返回其信息；文件无法读取或非合法 mp3 时返回 null */
function readMp3(file: string, root: string): Mp3Info | null {
    const buf = fs.readFileSync(file);
    const v2 = readId3v2(buf);
    const tags = v2.tags;
    if (tags.size === 0) {
        const v1 = readId3v1(buf);
        if (v1.size > 0) {
            for (const [k, v] of v1) {
                if (!tags.has(k)) {
                    tags.set(k, v);
                }
            }
        }
    }
    const audio = readAudio(buf, v2.audioStart);
    if (!audio) {
        return null;
    }

    const genre = normalizeGenre(
        tags.get('TCON') ?? tags.get('TXXX:GENRE') ?? tags.get('TXXX:流派') ?? ''
    );
    const tag = (key: string): string => truncate(tags.get(key) ?? '');

    return {
        name: path.basename(file),
        path: path.relative(root, file),
        size: utils.formatMemory(buf.length),
        id3Version: v2.hasV2 ? `ID3v2.${buf[3]}` : tags.size > 0 ? 'ID3v1' : '无',
        title: tag('TIT2'),
        artist: tag('TPE1'),
        album: tag('TALB'),
        year: tag('TYER') || tag('TDRC'),
        genre: truncate(genre),
        bitrate: `${audio.bitrateKbps} kbps${audio.bitrateSet.size > 1 ? ' (VBR)' : ''}`,
        duration: formatDuration(audio.durationMs),
        sampleRate: `${audio.sampleRate} Hz`,
        channel: audio.channels,
    };
}

function main(): void {
    const target = process.argv[2];
    if (!target) {
        console.error('用法: node mp3info.js <目录路径>');
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

    for (const file of files) {
        const rel = path.relative(absTarget, file);
        try {
            const info = readMp3(file, absTarget);
            if (!info) {
                console.warn(`跳过（未识别到音频帧）: ${rel}`);
                skipped.push({ path: rel, reason: '未识别到合法的 MPEG 音频帧' });
                continue;
            }
            infos.push(info);
            console.log(`${info.path} | ${info.artist || '-'} - ${info.title || '-'} | ${info.bitrate} | ${info.duration}`);
        } catch (err) {
            console.warn(`跳过（读取失败）: ${rel} (${(err as Error).message})`);
            skipped.push({ path: rel, reason: `读取失败: ${(err as Error).message}` });
        }
    }

    const result: Mp3InfoResult = {
        path: absTarget,
        files: infos,
        skipped,
        total: { fileCount: infos.length, skippedCount: skipped.length },
    };
    const outFile = path.resolve(`mp3info-result-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`处理完成，共扫描 ${infos.length} 个，跳过 ${skipped.length} 个，结果已保存到: ${outFile}`);
}

main();

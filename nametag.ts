#!/usr/bin/env node
/**
 * nametag 工具：根据 mp3info 的输出 JSON，为每个文件推断一个推荐文件名 star_name（"歌手 - 歌名"），
 * 供人工核对，之后可配合重命名命令按 star_name 批量改名。
 *
 * 用法：node nametag.js <mp3info-result.json>
 *
 * 推断策略（按可信度从高到低）：
 * 1. 广告/垃圾 artist（QQ/微信/DJ广告/3D环绕等）→ ID3 整体不可信，退回文件名解析。
 * 2. title 本身是 "歌手 - 歌名" 完整形式（如 "167.宋祖英 - 小背篓"）→ 从 title 拆出。
 * 3. 文件名 "X - Y"：
 *    - Y 与 title 吻合（文件名可能反序，如 "'Til Infinity - IYES"）→ 用 title 的 artist/title。
 *    - X 与 artist 吻合 → artist - title。
 *    - X 与 artist 不吻合 → 尝试 "artist - X"（X 更像歌名时）。
 * 4. 防重序号 ".N"：被文件名左/右段吸收说明序号可信；去掉序号后与 title 吻合 → 丢弃序号。
 * 5. 无 ID3 或 ID3 不可信 → 纯文件名解析（去数字前缀、去 .N 防重序号、去 (Live) 等版本标记、_ → 空格、连字符规范化）。
 * 6. 彻底不可名状（纯序号乱码等）→ star_name 留空。
 *
 * 每个文件输出 star_name 与判定来源 source：
 * - id3           ：ID3 歌手/歌名直接可用
 * - title-split   ：title 本身含 "歌手 - 歌名" 拆出
 * - reversed      ：文件名反序（Y 是歌名），按 title 重组
 * - dedup-suffix  ：去掉防重序号 .N 后与 title 吻合
 * - artist-x      ：文件名左段非歌手，按 "artist - 左段" 重组
 * - filename      ：纯文件名解析
 * - filename-best ：文件名解析的尽力而为（可能仍不理想）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Mp3File {
    name: string;
    artist?: string;
    title?: string;
    [k: string]: unknown;
}

interface StarName {
    /** 文件名 */
    name: string;
    /** 相对路径（供批量改名时定位原文件） */
    path?: string;
    /** 推荐名（"歌手 - 歌名"），无法可靠推断时为 "" */
    star_name: string;
    /** 推荐名来源 */
    source: string;
    /** 推荐名里的歌手 */
    star_artist: string;
    /** 推荐名里的歌名 */
    star_title: string;
}

interface NametagResult {
    input: string;
    files: StarName[];
    total: {
        count: number;
        id3: number;
        titleSplit: number;
        reversed: number;
        dedupSuffix: number;
        artistX: number;
        filename: number;
        filenameBest: number;
        empty: number;
    };
}

/** 版本标记：推荐名里应去掉的现场/版本后缀（大小写不敏感，中文括号也算，括号内任意位置含版本词即可，如 "(Slushii Remix)"） */
const RE_VERSION_TAG =
    /[（(][^)）]*(?:live|acoustic|dj\s*版|remix|karaoke|offical?|official|instrumental|伴奏|现场|翻唱|合唱|原唱|慢摇|电音|dj热播版)[^)）]*[)）]/gi;

/** 中文括号里的 3D环绕/DJ舞曲 等音效标记（对文件名版式特别常见） */
const RE_SOUND_TAG =
    /[（(]\s*(?:3D\s*环绕|DJ\s*舞曲|DJ\s*慢摇|车载|环绕)[^)）]*[)）]/gi;

/** 不带括号的 DJ/3D环绕 等尾部版本标记（如 " - 3D环绕中文DJ慢摇"、" mp3 版"；"Avicii - The Nights.3D" 的 .3D 也剥） */
const RE_SUFFIX_TAG =
    /(?:[-–—，,]\s*)?(?:3D\s*环绕|DJ\s*舞曲|DJ\s*慢摇|DJ热播|车载|环绕|原声|伴奏)\S*$|\.3D$|\s+mp3(?:\s*版)?$/i;

/** 括号/书名号里的 3D/DJ 音效标记："(3D双声道版)"、"「4D三声道」" → 去掉；对 id3 分支只剥歌名里的标记，歌手里的 DJ/4D 名不剥（"环绕4D小默" 是歌手名） */
const RE_SOUND_BRACKET =
    /[（(「【\[『][^)）」】\]』]*(?:3D|3\s*D|4D|DJ|车载|环绕|舞曲|慢摇|双声道|三声道|电音)[^)）」】\]』]*[)）」】\]』]/gi;

/** 裸 3D/4D 环绕标记（歌名里的 "3D环绕经典慢摇" → "经典慢摇"；仅用于 id3 分支的 title 部分；"4D立体环绕曲" 整词 → "曲"） */
const RE_SOUND_NAKED = /(?:[3D４D]{2}D?|3D)(?:环绕|立体环绕|酒吧慢摇|音效|神级|舞曲|快手火曲|超震撼|嗨曲)?/gi;

/** 专辑水印（"一人一首成名歌曲 港台版" 等整段背景信息，中间可有数字） */
const RE_ALBUM_MARK = /一人一首\s*\d*\s*成名(?:歌曲|歌|曲)[^,，。]*/gi;

/** 纯垃圾/广告歌手：ID3 整体不可信（含网站/水印/乱码/纯数字/书名号打包名/序号+歌名假歌手/群星占位/Track 占位） */
const RE_JUNK_ARTIST =
    /qq[:：\s]?\d{5,}|微信[:：\s]?\S+|车载|3D\s*环绕|DJ\s*[播放]?|全网音乐|抖音|快手|专业制作|请联系|欢迎定制|www\.|[a-z0-9]+\.(?:com|cn|net)\b|5583|kuwo|hinet|爱听|靠近收藏|多多高品质|跨界歌王|7妹|Crown\s*SACD|^\d{1,6}[.、\- ]|^\d{1,6}$|^[?？]+$|^非主流$|^群星$|^[^，。]*群星|^Track\s*\d{0,3}$|《|\[|[\u0000-\u001f]/i;
/** ID3 歌手含"群星"（群星/华语群星/群星【收藏】）→ 不能当歌手用 */
const RE_QUNXING_ARTIST = /群星/;

/** Track 序号占位歌名（"Track 01"、"track01"），不能当歌名用 */
const RE_TRACK = /^track\s*\d{0,3}$/i;

/** 歌名里常见的词：当文件名左段单独成歌名候选时，用这些词辅助判断 */
const TITLE_HINTS = /^(track|song|music|音频|伴奏|舞曲|铃声|纯音乐)\s*\d*$/i;

const splitExt = (n: string): [string, string] => {
    const i = n.lastIndexOf('.');
    return [i < 0 ? n : n.slice(0, i), i < 0 ? '' : n.slice(i + 1)];
};

/** 规范化英文歌名/歌手：去掉修饰括号、非字母数字，便于比较 */
const normForCompare = (s: string): string =>
    s.replace(RE_VERSION_TAG, ' ').replace(/[（(].*?[)）]/g, ' ').replace(/[^a-z0-9一-鿿가-힯Ѐ-ӿ]/gi, '').toLowerCase();

/** 去掉文件名里的 .N 防重序号（末尾 "数字.数字" 且以 mp3 结尾的形态） */
const stripDedup = (base: string): string => base.replace(/\.\d{1,6}$/, '');

/**
 * 文件名主解析：处理 数字前缀（003.孙露-... / 01 - ... / 10宋祖英 - ...）、
 * 防重序号 .N、版本标记 (Live) 等、_ 连接符、连字符规范化，输出 {artist, title} 或 null（不可名状）。
 */
function parseFilename(base: string): { artist: string; title: string } | null {
    let s = base.replace(/\.mp3$/i, '').trim();
    // 先摘掉防重序号与版本标记，避免干扰下面的主分割
    s = stripDedup(s);
    // 去掉版本标记（"歌手 - 歌名 (Live)" → "歌手 - 歌名"）
    s = s.replace(RE_VERSION_TAG, ' ').replace(RE_BRACKET_VERSION, '').replace(RE_SOUND_TAG, '').replace(RE_SUFFIX_TAG, '').replace(RE_ALBUM_MARK, '').replace(RE_SOUND_BRACKET, '').replace(/[（(]\s*[)）]/g, ' ').trim();
    // _ 连接符 → 空格（DJ何鹏_陈瑞 → DJ何鹏 陈瑞）
    s = s.replace(/_/g, ' ').replace(/ {2,}/g, ' ').trim();
    // 数字序号前缀：003.孙露 → 003. → 孙露；01 - 1东方红 → 01 - → 1东方红（注意只剥序号）
    // 先剥 "数字.名" 的点号序号（如 "148Mp3_F.I.R..." 不会误伤，因为紧跟的是字母）
    s = s.replace(/^\d+\.\s*/, '');
    // 再剥 "数字 - 名" 或 "数字名" 的序号（数字后紧跟汉字才算，且至少 2 个汉字，避免误伤 "2PM"/"17岁"）
    s = s.replace(/^\d+[ -]\s*/, '');
    if (/^\d+[一-鿿]{2,}/.test(s)) {
        s = s.replace(/^\d+/, '');
    }
    // 遗留的 "数字+字母" 前缀：只剥数字，保留字母部分（"123DJ何鹏" → "DJ何鹏"；"01Olly Murs" → "Olly Murs"）
    // "2PM - ..."、"7!! - ..." 这类数字是歌名本身，不剥
    s = s.replace(/^\d+(?=[A-Za-z]+[一-鿿])/, '');
    s = s.replace(/^\d+(?=[A-Za-z]+\s+[A-Za-z])/, '');
    // 盗版水印前缀（"148Mp3_F.I.R我们的爱" → "F.I.R我们的爱"；全角"３Ｄ"同理）
    s = s.replace(/^[0-9０-９]*mp3\s*/i, '').replace(/^３\s*Ｄ\s*/i, '');
    // 末尾孤立的右括号才去掉（"奔跑Dance弹)" → "奔跑Dance弹"；括号配平的不动）
    if (/[)）]\s*$/.test(s)) {
        const opens = (s.match(/[（(]/g) || []).length;
        const closes = (s.match(/[)）]/g) || []).length;
        if (closes > opens) {
            s = s.replace(/[)）]\s*$/, '');
        }
    }
    s = s.trim();
    // 主分割：按 " - " 拆，多于两段时从最后一段往前找"歌手 - 歌名 - 版本"中的歌名
    const parts = s.split(' - ').map((p) => p.trim());
    if (parts.length < 2) {
        // 无分隔符：整段当作歌名（如 "爱的故事上集dj"）
        return /^[\d.]+$/.test(s) ? null : { artist: '', title: s };
    }
    // 两段最常见："歌手 - 歌名"
    if (parts.length === 2) {
        return { artist: parts[0], title: parts[1] };
    }
    // 三段以上："歌手 - 歌名 - 版本"（如 "孙露 - 让我欢喜让我忧 - 3D环绕音乐"）
    // 最后一段若是版本/发行等描述词，歌名取中间段
    const tail = parts[parts.length - 1];
    if (/^(3D环绕音乐|伴奏|舞曲|现场版|live|remix|合唱|原唱|女声|男声)$/i.test(tail)) {
        return { artist: parts[0], title: parts.slice(1, -1).join(' - ') };
    }
    // 无法确定：取首段当歌手、其余段当歌名
    return { artist: parts[0], title: parts.slice(1).join(' - ') };
}

/** 歌名里常见的版本/发行后缀：括号里是版本词时整体去掉，其余保留 */
const RE_BRACKET_VERSION =
    /[（(]\s*(?:live|acoustic|dj\s*版|remix|karaoke|offical?|official|instrumental|伴奏|现场|翻唱|合唱|原唱|慢摇|电音|dj热播版|dj咚鼓版|加强嗨版|extended\s*mix|radio\s*mix|抒情|蓝调|舞曲)[^)）]*[)）]/gi;

/** 去掉版本词标记，保留歌名 */
const stripVersion = (s: string): string => {
    let r = s
        .replace(RE_VERSION_TAG, ' ')
        .replace(RE_BRACKET_VERSION, '')
        .replace(RE_SOUND_TAG, '')
        .replace(RE_SOUND_BRACKET, '');
    // 尾部嵌套括号组自内向外剥掉（"（我和我破碎的心（玻璃心））" → 全剥），其余括号保留
    let prev: string;
    do {
        prev = r;
        r = r.replace(/[（(][^()（）]*[)）]\s*$/g, '');
    } while (r !== prev);
    return r.trim();
};

/** 换行/多余空格→单空格，去首尾标点，连续多个点压成一个 */
const tidyName = (s: string): string =>
    stripVersion(s)
        .replace(/\s+/g, ' ')
        .replace(/\.{2,}/g, '.')
        .replace(/^\s*[-–—.。、，,;；:：\s]+|\s*[-–—.。、，,;；:：\s]+$/g, '')
        .trim();

/** Windows 禁止的字符 → 全角，连续点压成一个，首尾空格/点去掉（批量改名前的最后一道净化） */
const sanitizeName = (s: string): string =>
    s
        .replace(/[<>:"/\\|?*]/g, (c) => ({ '<': '＜', '>': '＞', ':': '：', '"': '＂', '/': '／', '\\': '＼', '|': '｜', '?': '？', '*': '＊' })[c] ?? c)
        .replace(/\.{2,}/g, '.')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .trim();

/** 把一段文本里的 "歌手 - 歌名" 拆出来（title 或文件名左段可能是 "歌手 - 歌名" 整体） */
function splitArtistTitle(text: string): { artist: string; title: string } | null {
    const t = text.replace(/^\d+\.?\s*/, '').trim(); // 去掉 "167." 之类序号
    const m = t.match(/^(.+?)\s+-\s+(.+)$/);
    if (!m) {
        return null;
    }
    return { artist: tidyName(m[1]), title: tidyName(m[2]) };
}

/** title 是无空格连字符的复合形态时，把首/末段的歌手摘出来（如 "01-小猪佩奇（DJ版）-98k、沈念"、"Michael Jackson-Billie Jean"） */
function splitBareDash(text: string, artist: string): { artist: string; title: string } | null {
    const esc = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 段首/段尾的歌手，可带合作歌手后缀（"98k" 后接 "、沈念"、"安浩辰" 后接 "+沈念"）
    const headRe = new RegExp(`^${esc}(?:[、,，&/·\\s+]+.*)?$`);
    const tailRe = new RegExp(`^(?:.*[、,，&/·\\s+]+)?${esc}$`);
    const parts = text.split(/\s*-\s*/).map((p) => p.trim());
    if (parts.length < 2) {
        return null;
    }
    const first = parts[0];
    const last = parts[parts.length - 1];
    let sp: { artist: string; title: string } | null = null;
    if (headRe.test(last) || tailRe.test(last)) {
        sp = { artist: last, title: parts.slice(0, -1).join(' - ') };
    } else if (headRe.test(first) || tailRe.test(first)) {
        sp = { artist: first, title: parts.slice(1).join(' - ') };
    }
    if (!sp) {
        return null;
    }
    const title = sp.title.replace(/^\d+[.、\- ]\s*/, ''); // "01 - " 之类序号
    return { artist: tidyName(sp.artist), title: tidyName(title) };
}

/**
 * 对单个文件推断 star_name。
 * 返回 { star_name, source, star_artist, star_title }。
 */
function recommend(f: Mp3File): StarName {
    const name = f.name;
    const id3Artist = (f.artist ?? '').trim();
    const id3Title = (f.title ?? '').trim();
    // 歌名里的裸 3D/4D 环绕标记（"3D环绕经典慢摇" → "经典慢摇"；"3D西游记" → "西游记"）
    // 与不带括号的尾部版本标记（"我的新娘在草原 DJ舞曲" → "我的新娘在草原"）
    const id3TitleClean = id3Title
        .replace(RE_SOUND_NAKED, '')
        .replace(RE_SUFFIX_TAG, '')
        // 歌名尾部重复歌手名的水印（"舍不得也要说再见 六哲" → "舍不得也要说再见"）
        .replace(new RegExp(`\\s*${id3Artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '')
        // 歌名首部重复歌手名的水印（"Mc深七-樱花树下的约定" → "樱花树下的约定"）
        .replace(new RegExp(`^${id3Artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-`), '')
        // "一辈子的赌注-DJ版-阿远" 这类"歌名-版本-歌手"水印 → 只留歌名
        .replace(/-DJ版-[\s\S]*$/, '')
        // 歌名首部重复歌手名但带空格版（"高进 多想把你抱住" → "多想把你抱住"）
        .replace(new RegExp(`^${id3Artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`), '')
        // 歌名首部 "歌手《歌名》" 水印（"扬墨《哪儿凉快哪儿呆》" → "哪儿凉快哪儿呆"；"1、马吟吟《 隐匿的盛宴》" → "隐匿的盛宴"）
        .replace(new RegExp(`^(?:\\d+[、.\\- ]\\s*)?${id3Artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*《([^》]*)》$`), '$1')
        .trim();
    // 各分支共用结果：优先用干净歌名，歌名空时才退回原歌名
    const finalTitle = id3TitleClean || id3Title;
    // 6 位以内的数字/含 `[` 或 `《`/非文本符号（乱码）的 title 不可靠，改由文件名右段确认
    // （"053.中毒的爱情"、"022饿狼传说[张学友正版"、"Ë­°éÎÒ´³µ´" 等）
    const finalWeak = /^\d{1,6}$/.test(finalTitle) || /[《\[]/.test(finalTitle) || (finalTitle !== '' && !normForCompare(finalTitle));
    const normTitle = normForCompare(id3Title);
    const normArtist = normForCompare(id3Artist);
    // ID3 不可信（广告/垃圾）→ 整体退回文件名解析
    const junkId3 = !!(id3Artist && RE_JUNK_ARTIST.test(id3Artist));

    // ---- 0) ID3 title 把歌手包进去了（"01-小猪佩奇（DJ版）-98k、沈念" / "Michael Jackson-Billie Jean"）→ 拆出歌手 ----
    if (!junkId3 && id3Artist && id3Title && !id3Title.includes(' - ') && normTitle.includes(normArtist) && normTitle.length > normArtist.length + 2) {
        const sp = splitBareDash(id3Title, id3Artist);
        if (sp) {
            return {
                name,
                star_name: sanitizeName(`${sp.artist} - ${sp.title}`),
                source: 'id3',
                star_artist: sp.artist,
                star_title: sp.title,
            };
        }
    }
    // ---- 0b) Track 占位歌名（"Track 01"）→ 改用文件名右段当歌名 ----
    if (!junkId3 && id3Artist && id3Title && RE_TRACK.test(id3Title)) {
        const [baseNoExt2] = splitExt(name);
        const base2 = stripDedup(baseNoExt2.replace(/\.mp3$/i, '')).trim();
        const dashIdx2 = base2.lastIndexOf(' - ');
        const right2 = dashIdx2 >= 0 ? base2.slice(dashIdx2 + 3).trim() : '';
        if (right2 && !RE_TRACK.test(right2)) {
            return {
                name,
                star_name: sanitizeName(`${id3Artist} - ${tidyName(right2)}`),
                source: 'id3',
                star_artist: id3Artist,
                star_title: tidyName(right2),
            };
        }
    }

    // ---- 0c) 群星等专辑占位歌手（群星/华语群星/群星【收藏】）→ 歌手位不可用，从文件名里找真实歌手或只留歌名 ----
    if (id3Artist && RE_QUNXING_ARTIST.test(id3Artist)) {
        const p = parseFilename(name);
        if (p) {
            let artist = (p.artist || '').trim();
            let title = (p.title || '').trim();
            // ID3 title 是 "歌名-群星" 复合（"如果你是我眼中的一滴泪-群星"）→ 去掉尾部群星，歌名更完整
            if (id3Title) {
                const tClean = id3Title.replace(/[-–—]\s*群星\s*$/, '');
                if (tClean !== id3Title && !/群星/.test(tClean)) {
                    title = tClean;
                }
            }
            // "X - 群星" 反序：群星位是假歌手，左段 X 才是歌名（"如果你是我眼中的一滴泪 - 群星" → 歌名"如果你是我眼中的一滴泪"）
            if (/群星/.test(title) && artist && !RE_QUNXING_ARTIST.test(artist)) {
                title = artist;
                artist = '';
            }
            if (!artist || RE_QUNXING_ARTIST.test(artist)) {
                artist = ''; // 歌手位是群星：丢弃（"华语群星 - 少林英雄" → "少林英雄"）
            }
            const starName = sanitizeName([artist, title].filter(Boolean).join(' - '));
            if (starName) {
                return {
                    name,
                    star_name: starName,
                    source: 'filename',
                    star_artist: artist ? tidyName(artist) : '',
                    star_title: tidyName(title),
                };
            }
        }
    }

    // 文件名去掉扩展名与 .N 防重序号后的主体
    const [baseNoExt] = splitExt(name);
    const base = stripDedup(baseNoExt.replace(/\.mp3$/i, '')).trim();
    const dashIdx = base.lastIndexOf(' - ');
    const left = dashIdx >= 0 ? base.slice(0, dashIdx).trim() : '';
    const right = dashIdx >= 0 ? base.slice(dashIdx + 3).trim() : '';
    const normLeft = normForCompare(left);
    const normRight = normForCompare(right);

    // ---- 1) title 本身是 "歌手 - 歌名" 完整形式（如 "167.宋祖英 - 小背篓"）----
    if (!junkId3 && id3Title && id3Artist && id3Title.includes(' - ') && id3Title.includes(id3Artist)) {
        const sp = splitArtistTitle(id3Title);
        if (sp) {
            return {
                name,
                star_name: sanitizeName(`${sp.artist} - ${sp.title}`),
                source: 'title-split',
                star_artist: sp.artist,
                star_title: sp.title,
            };
        }
    }

    // ---- 2) ID3 完整可信 且 文件名是 "X - Y" 形态 ----
    //     在 id3TitleClean 基础上：压 `..` 连续点、去竖线拖尾扩展信息（Beyond 案例）、去首部"歌手《歌名》"水印
    const t2 = finalTitle.replace(/\.\.+/, '..');
    const tailSep = t2.indexOf('|');
    const id3TitleT2 = tailSep > 0 ? t2.slice(0, tailSep) : t2;
    const leadingBook = id3TitleT2.match(new RegExp(`^(?:\\d+[、.\\- ]\\s*)?${id3Artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*《([^》]*)》$`));
    const t3 = (leadingBook ? leadingBook[1] : id3TitleT2).replace(/^(?:网络歌曲|伤感歌曲|新歌首发)\s*《([^》]*)》$/, '$1');
    // 6 位以内的数字/含 `[` 或 `《` 的歌名，改由文件名右段确认
    const tWeak = /^\d{1,6}$/.test(t3) || /[《\[]/.test(t3);
    if (!junkId3 && id3Artist && id3Title && left && right) {
        // 2a) X 与 title 吻合 → 文件名是 "歌名 - 歌手" 反序，重组为 "歌手 - 歌名"。
        //     但若反序后歌手==歌名（X 是歌手而非歌名，如 "Michael Jackson - Billie Jean" 的 X 是 MJ），
        //     说明其实没反序，X 就是歌手 → 用 id3（"artist - title"）
        //     三种情形不判反序：X 含 " - "（本身是 "歌手-歌名" 多段，如 "Adele - Someone Like You - 阿黛尔"）、
        //     X 是歌手列表（含 、/_ 分隔，如 "98k、沈念 - 小猪佩奇"、"任贤齐 _ 摩登兄弟 - 兄弟"）、
        //     title 已含歌手（title 是 "歌名-歌手" 完整形态）
        const normT3 = normForCompare(t3);
        const xLooksReversed =
            !left.includes(' - ') &&
            !/[、_]/.test(left) &&
            normLeft && normT3 && normLeft.length >= 2 &&
            (normLeft.includes(normT3) || normT3.includes(normLeft)) &&
            !(normArtist.length >= 2 && normT3.includes(normArtist));
        if (xLooksReversed && !(normLeft.includes(normArtist) && normArtist.length >= 2 && normArtist.includes(normLeft))) {
            return {
                name,
                star_name: sanitizeName(`${id3Artist} - ${tidyName(left)}`),
                source: 'reversed',
                star_artist: id3Artist,
                star_title: tidyName(left),
            };
        }
        // 2b) X 与 artist 吻合（或右段与 title 吻合）→ "artist - title"
        //     左右段比 ID3 更可信：X 像真实歌手（非纯数字/DJ 噪声）时用 X，右段与 title 吻合时用右段当歌名
        const rMatches = normT3 && normRight && t3 && !tWeak && (normRight.includes(normForCompare(t3)) || normForCompare(t3).includes(normRight));
        if ((normLeft && normLeft.length >= 2 && (normLeft.includes(normArtist) || normArtist.includes(normLeft))) || rMatches) {
            const useLeft = normLeft && normLeft.length >= 2 && !/^\d+$/.test(left) && !/^DJ/i.test(left) && !RE_QUNXING_ARTIST.test(left);
            const artist2 = useLeft ? left : id3Artist;
            // 右段像歌名（非纯数字、无书名号/方括号）时优先用右段——比 ID3 title 更贴近文件名
            // （"张嘉洵 - 男人真累" title 却是 "张嘉洵"、"马吟吟 - 隐匿的盛宴" title 是 "1、马吟吟《 隐匿的盛宴》"）
            const rightOk = right && normForCompare(right).length >= 2 && !/[《\[]/.test(right);
            const title2 = rMatches || rightOk ? tidyName(right) : tidyName(t3);
            if (rightOk && !rMatches && /^DJ$/i.test(id3Artist) && artist2 === id3Artist && id3Title.length >= 2) {
                // ID3 artist 就是 "DJ"：右段歌名无标题佐证，直接用 ID3 的 title 更可靠（"DJ - 午夜DJ"）
                return {
                    name,
                    star_name: sanitizeName(`${id3Artist} - ${tidyName(t3)}`),
                    source: 'id3',
                    star_artist: id3Artist,
                    star_title: tidyName(t3),
                };
            }
            return {
                name,
                star_name: sanitizeName(`${artist2} - ${title2}`),
                source: 'id3',
                star_artist: tidyName(artist2),
                star_title: title2,
            };
        }
        // 2c) 文件名左右段与 ID3 都不吻合（如 "01 - 1东方红"、乱码名）→ 直接用 ID3
        if (finalWeak) {
            // title 不可靠：改用文件名右段当歌名（"053.中毒的爱情 - 053.中毒的爱情" → "流行歌曲 - 中毒的爱情"）
            const rightTitle = right && normForCompare(right) && !/[《\[]/.test(right) ? tidyName(right) : '';
            if (!rightTitle) {
                return { name, star_name: '', source: 'empty', star_artist: '', star_title: '' };
            }
            // 左段若是群星占位（"华语群星 - 谁伴我闯荡"），不能当歌手 → 只留歌名
            if (left && RE_QUNXING_ARTIST.test(left)) {
                return { name, star_name: sanitizeName(rightTitle), source: 'id3', star_artist: '', star_title: rightTitle };
            }
            return { name, star_name: sanitizeName(`${left} - ${rightTitle}`), source: 'id3', star_artist: tidyName(left), star_title: rightTitle };
        }
        // 2c2) 右段是群星（"如果你是我眼中的一滴泪 - 群星"）→ 群星位是假歌手，整段当歌名
        if (right && RE_QUNXING_ARTIST.test(right)) {
            return { name, star_name: sanitizeName(left), source: 'id3', star_artist: '', star_title: tidyName(left) };
        }
        return {
            name,
            star_name: sanitizeName(`${id3Artist} - ${tidyName(t3)}`),
            source: 'id3',
            star_artist: id3Artist,
            star_title: tidyName(t3),
        };
    }

    // ---- 2d) ID3 完整可信，文件名无 " - " 分隔 → 同上（合并到 3）----

    // ---- 3) ID3 完整可信，但文件名无 " - " 分隔（"歌名.mp3" 或 "歌名.N.mp3"）----
    if (!junkId3 && id3Artist && id3Title) {
        // 3a) 去防重序号后主体与 title 吻合（.N 是防重序号，丢弃）
        if (base !== baseNoExt.replace(/\.mp3$/i, '') && normForCompare(base) === normTitle && normForCompare(base) !== normForCompare(right || left)) {
            return {
                name,
                star_name: sanitizeName(`${id3Artist} - ${finalTitle}`),
                source: 'dedup-suffix',
                star_artist: id3Artist,
                star_title: tidyName(finalTitle),
            };
        }
        // 3b) 主体与 title 吻合（纯歌名文件，无防重序号）→ 补上 ID3 歌手
        if (normForCompare(base) === normTitle && normForCompare(base)) {
            return {
                name,
                star_name: sanitizeName(`${id3Artist} - ${finalTitle}`),
                source: 'id3',
                star_artist: id3Artist,
                star_title: tidyName(finalTitle),
            };
        }
        // 3c) 主体与 title 不吻合 → 用 ID3（文件名是 track 序号等不可用信息）
        return {
            name,
            star_name: sanitizeName(`${id3Artist} - ${finalTitle}`),
            source: 'id3',
            star_artist: id3Artist,
            star_title: tidyName(finalTitle),
        };
    }

    // ---- 4) ID3 不完整或不可信 → 文件名解析 ----
    const p = parseFilename(name);
    if (p) {
        // 若解析出的 artist 与 ID3 artist 一致，且 ID3 title 存在，用 ID3 的 title 更可靠
        const useId3Title = id3Artist && p.artist && normForCompare(p.artist) === normForCompare(id3Artist) && id3Title;
        let starArtist = useId3Title ? id3Artist : p.artist;
        const starTitle = useId3Title ? (id3TitleClean || id3Title) : p.title;
        // 歌手里的 "3D小默/环绕4D小默/海潮哥" 是真实人名，不去；歌名里的 3D 环绕标记才去（如 "3D环绕经典慢摇"）
        let starTitle2 = starTitle ? starTitle.replace(RE_SOUND_NAKED, '').trim() : '';
        // 群星占位：artist 是群星 → 丢弃；title 里独立的"群星"段 → 丢弃（"X - 群星" → 歌名 X，"X - 群星 - Y" → X - Y）
        if (starArtist && RE_QUNXING_ARTIST.test(starArtist)) starArtist = '';
        if (starTitle2) {
            const segs = starTitle2.split(/\s*[-–—]\s*/).filter((x) => x);
            if (segs.length > 1) {
                const kept = segs.filter((x) => !/^[^，。]{0,6}群星$/.test(x));
                starTitle2 = kept.length ? kept.join(' - ') : '';
            } else if (/^[^，。]{0,6}群星$/.test(starTitle2)) {
                starTitle2 = '';
            }
        }
        if (starTitle2 === starArtist) starTitle2 = '';
        // 群星/占位剥离后只剩歌手位时，歌手位实际是歌名（"X - 群星"、"爸爸去哪儿 - 爸爸去哪儿"）→ 提升为歌名，歌手清空
        if (!starTitle2 && starArtist) {
            starTitle2 = starArtist;
            starArtist = '';
        }
        const starName = sanitizeName([starArtist, starTitle2].filter(Boolean).join(' - '));
        if (starName) {
            return {
                name,
                star_name: starName,
                source: useId3Title ? 'id3' : 'filename',
                star_artist: tidyName(starArtist),
                star_title: tidyName(starTitle2),
            };
        }
    }

    // ---- 5) 彻底不可名状 ----
    return { name, star_name: '', source: 'empty', star_artist: '', star_title: '' };
}

function main(): void {
    const input = process.argv[2];
    if (!input) {
        console.error('用法: node nametag.js <mp3info-result.json>');
        process.exit(1);
    }
    if (!fs.existsSync(input)) {
        console.error(`错误: 文件不存在: ${input}`);
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(input, 'utf8')) as { files: Mp3File[] };
    const files = data.files.map(recommend);
    // 重名核对：重复出现的 star_name 追加防重序号 .N（保证批量改名不冲突）
    const seen = new Map<string, number>();
    for (const r of files) {
        if (!r.star_name) {
            continue;
        }
        const n = (seen.get(r.star_name) ?? 0) + 1;
        seen.set(r.star_name, n);
        if (n > 1) {
            r.star_name = `${r.star_name}.${n}`;
        }
    }
    // 供后续批量改名/配 .lrc 用：带上原文件的相对路径
    const filesOut = files.map((r, i) => ({ ...r, path: String(data.files[i].path ?? '') }));
    const countOf = (s: string) => files.filter((x) => x.source === s).length;
    const total = {
        count: files.length,
        id3: countOf('id3'),
        titleSplit: countOf('title-split'),
        reversed: countOf('reversed'),
        dedupSuffix: countOf('dedup-suffix'),
        artistX: countOf('artist-x'),
        filename: countOf('filename'),
        filenameBest: countOf('filename-best'),
        empty: countOf('empty'),
    };
    const result: NametagResult = { input, files: filesOut, total };
    const outFile = path.resolve(`nametag-result-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`处理完成，共 ${files.length} 个：ID3 ${total.id3}、title拆解 ${total.titleSplit}、反序 ${total.reversed}、去防重 ${total.dedupSuffix}、artist-左段 ${total.artistX}、文件名解析 ${total.filename}、留空 ${total.empty}，结果已保存到: ${outFile}`);
}

main();

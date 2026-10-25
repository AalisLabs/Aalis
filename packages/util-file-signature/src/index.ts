// ============================================================
// @aalis/util-file-signature — 按文件内容认定文件类型
//
// 扩展名、Content-Type 与 data URL 里写的类型都是别人写的标签，不说明内容是什么：存储根里除了媒体，还有配置、令牌、
// 记忆库、日志，只凭 kind 与路径发送，这些文件会被当成图片发出去；扩展名写错的图按错的格式交出去，产出打不开的文档。
// 要按类型处理文件的一方读文件的字节，按下面的签名认定格式，再决定放行、换一种方式处理还是拒绝：媒体看文件头，文档、
// 文本与动图看整份字节。格式到扩展名与 MIME 的映射由同一张签名表给出，各包不另写。
// 签名依据各格式的规范，并与 file(1) 的 magic 库对照（SILK 不在该库里）。
// 纯函数、无依赖，只用 Uint8Array，浏览器里也能用。
// ============================================================

/** 可发送的附件类型。 */
export type MediaKind = 'image' | 'audio' | 'video';

/** 签名表认得的媒体格式名。 */
export type MediaFormatName =
  | 'PNG'
  | 'JPEG'
  | 'GIF'
  | 'WebP'
  | 'BMP'
  | 'AVIF'
  | 'HEIC'
  | 'MP3'
  | 'WAV'
  | 'OGG'
  | 'FLAC'
  | 'AMR'
  | 'SILK'
  | 'M4A'
  | 'MP4'
  | 'MOV'
  | 'WebM'
  | 'MKV'
  | 'AVI';

/** 文件头认出的媒体格式：所属类型、格式名（如 PNG、M4A、MKV）、落盘用的扩展名（不带点）与 MIME 类型。 */
export interface MediaFormat {
  kind: MediaKind;
  format: MediaFormatName;
  ext: string;
  mime: string;
}

/**
 * 认定媒体格式要读的文件头长度：与 file(1) 在前 4 KiB 里找 Matroska DocType 的范围一致，也容得下 ftyp 盒的
 * 兼容品牌表；其余签名都在前 20 字节内。
 */
export const FILE_HEAD_BYTES = 4096;

/** 媒体种类的中文名：给模型看的说明里用（如「PNG 图片」） */
export const MEDIA_KIND_LABEL: Readonly<Record<MediaKind, string>> = { image: '图片', audio: '音频', video: '视频' };

/** BMP 偏移 14 处 DIB 头长度的合法取值（file(1) 认的各版本）；只有 'BM' 两字节太弱，文本也可能以它开头。 */
const BMP_DIB_HEADER_SIZES = new Set([12, 16, 24, 40, 48, 52, 56, 64, 108, 124]);
/** AMR 文件存储格式的魔数：单声道窄带、宽带与各自的多声道版本（RFC 4867 §5）。 */
const AMR_MAGICS = ['#!AMR\n', '#!AMR-WB\n', '#!AMR_MC1.0\n', '#!AMR-WB_MC1.0\n'];
const AVIF_BRANDS = new Set(['avif', 'avis']);
/** HEIF 的图片与图片序列品牌（ISO/IEC 23008-12）：HEVC 编码的 heic 系与通用的 mif1、msf1。 */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);
const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);

interface MediaSignature extends MediaFormat {
  matches(head: Uint8Array): boolean;
}

/** 按先后比对；SILK 没有登记的 MIME，取通行的 audio/silk */
const SIGNATURES: readonly MediaSignature[] = [
  {
    kind: 'image',
    format: 'PNG',
    ext: 'png',
    mime: 'image/png',
    matches: h => hasBytes(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  // SOI 标记 FFD8 之后紧跟下一个标记的 FF
  { kind: 'image', format: 'JPEG', ext: 'jpg', mime: 'image/jpeg', matches: h => hasBytes(h, 0, [0xff, 0xd8, 0xff]) },
  {
    kind: 'image',
    format: 'GIF',
    ext: 'gif',
    mime: 'image/gif',
    matches: h => hasAscii(h, 0, 'GIF87a') || hasAscii(h, 0, 'GIF89a'),
  },
  { kind: 'image', format: 'WebP', ext: 'webp', mime: 'image/webp', matches: h => isRiff(h, 'WEBP') },
  {
    kind: 'image',
    format: 'BMP',
    ext: 'bmp',
    mime: 'image/bmp',
    matches: h => hasAscii(h, 0, 'BM') && h.length >= 18 && BMP_DIB_HEADER_SIZES.has(readUint32LE(h, 14)),
  },
  { kind: 'image', format: 'AVIF', ext: 'avif', mime: 'image/avif', matches: h => isoMediaFormat(h) === 'AVIF' },
  { kind: 'image', format: 'HEIC', ext: 'heic', mime: 'image/heic', matches: h => isoMediaFormat(h) === 'HEIC' },
  { kind: 'audio', format: 'MP3', ext: 'mp3', mime: 'audio/mpeg', matches: h => isId3v2(h) || isMp3Frame(h) },
  { kind: 'audio', format: 'WAV', ext: 'wav', mime: 'audio/wav', matches: h => isRiff(h, 'WAVE') },
  // 页头捕获模式 'OggS' 加结构版本 0（RFC 3533）
  {
    kind: 'audio',
    format: 'OGG',
    ext: 'ogg',
    mime: 'audio/ogg',
    matches: h => hasBytes(h, 0, [0x4f, 0x67, 0x67, 0x53, 0x00]),
  },
  { kind: 'audio', format: 'FLAC', ext: 'flac', mime: 'audio/flac', matches: h => hasAscii(h, 0, 'fLaC') },
  {
    kind: 'audio',
    format: 'AMR',
    ext: 'amr',
    mime: 'audio/amr',
    matches: h => AMR_MAGICS.some(m => hasAscii(h, 0, m)),
  },
  // QQ 语音的 SILK 前面可能多一个 0x02
  {
    kind: 'audio',
    format: 'SILK',
    ext: 'silk',
    mime: 'audio/silk',
    matches: h => hasAscii(h, 0, '#!SILK_V3') || (h[0] === 0x02 && hasAscii(h, 1, '#!SILK_V3')),
  },
  { kind: 'audio', format: 'M4A', ext: 'm4a', mime: 'audio/mp4', matches: h => isoMediaFormat(h) === 'M4A' },
  { kind: 'video', format: 'MP4', ext: 'mp4', mime: 'video/mp4', matches: h => isoMediaFormat(h) === 'MP4' },
  { kind: 'video', format: 'MOV', ext: 'mov', mime: 'video/quicktime', matches: h => isoMediaFormat(h) === 'MOV' },
  { kind: 'video', format: 'WebM', ext: 'webm', mime: 'video/webm', matches: h => ebmlDocType(h) === 'webm' },
  {
    kind: 'video',
    format: 'MKV',
    ext: 'mkv',
    mime: 'video/x-matroska',
    matches: h => ebmlDocType(h) === 'matroska',
  },
  { kind: 'video', format: 'AVI', ext: 'avi', mime: 'video/x-msvideo', matches: h => isRiff(h, 'AVI ') },
];

const formatOf = ({ kind, format, ext, mime }: MediaSignature): MediaFormat => ({ kind, format, ext, mime });

/** 按格式名查扩展名与 MIME：存下的是判定出的类型、之后不再有字节可判的一方用（如按类型给成品起名） */
export const MEDIA_FORMATS = Object.fromEntries(SIGNATURES.map(s => [s.format, formatOf(s)])) as Readonly<
  Record<MediaFormatName, MediaFormat>
>;

/** 按文件头认定媒体格式；不是签名表里任何一种格式时返回 null。 */
export function detectMediaFormat(head: Uint8Array): MediaFormat | null {
  const detected = SIGNATURES.find(s => s.matches(head));
  return detected ? formatOf(detected) : null;
}

/**
 * 核对文件头是否为所请求 kind 的受支持格式。相符返回 null；不符返回给模型的拒发说明：
 * 不是任何受支持的媒体格式时说明不能按该类型发送，是别类媒体时说出检测到的格式与该用的 kind。
 */
export function checkMediaHead(head: Uint8Array, kind: MediaKind): string | null {
  const detected = detectMediaFormat(head);
  if (!detected) {
    const supported = SIGNATURES.filter(s => s.kind === kind)
      .map(s => s.format)
      .join('、');
    return `文件不是受支持的${MEDIA_KIND_LABEL[kind]}格式（${supported}），不能按 ${kind} 发送`;
  }
  if (detected.kind !== kind) {
    return `文件是 ${detected.format} ${MEDIA_KIND_LABEL[detected.kind]}，不能按 ${kind} 发送；请改用 kind=${detected.kind} 重新发送`;
  }
  return null;
}

/** 认得出的文档格式：PDF、Word 2007 起的 DOCX，与旧版 doc、xls、ppt 共用的复合文档（OLE）。 */
export type DocumentFormat = 'PDF' | 'DOCX' | 'OLE';

/** 复合文档（OLE2）的魔数 */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** ZIP 本地文件头的签名 PK\x03\x04 */
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];

/**
 * 按内容认定文档格式；不是这几种时返回 null。PDF 认 `%PDF-`，OLE 认复合文档魔数；DOCX 是 ZIP，要整份字节：本地文件头里
 * 有 `word/document.xml` 条目才算（xlsx、pptx 与普通压缩包都是 ZIP）。
 */
export function detectDocumentFormat(bytes: Uint8Array): DocumentFormat | null {
  if (hasAscii(bytes, 0, '%PDF-')) return 'PDF';
  if (hasBytes(bytes, 0, OLE_MAGIC)) return 'OLE';
  if (hasBytes(bytes, 0, ZIP_LOCAL_HEADER) && zipHasEntry(bytes, 'word/document.xml')) return 'DOCX';
  return null;
}

/** 不合法的 UTF-8 抛错；开头的 BOM 按默认去掉 */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * 按 UTF-8 解成文本，去掉开头的 BOM；不是合法的 UTF-8、或含 NUL 字节（二进制文件的特征）的返回 null。只认 UTF-8：GBK
 * 等编码的文本判成不是文本，不硬解出乱码。要整份字节，截断处可能切开一个多字节字符。
 */
export function decodeUtf8Text(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\0') ? null : text;
}

/**
 * 是不是动图，要整份字节：GIF 按块走到第二个图像描述符算，PNG 在 IDAT 之前有 acTL（APNG）算，WebP 的 VP8X 带动画位或
 * 有 ANIM、ANMF 块算。单帧的 GIF 不算；别的格式都不算（视频按 detectMediaFormat 的 kind 认）。
 */
export function isAnimatedImage(bytes: Uint8Array): boolean {
  switch (detectMediaFormat(bytes.subarray(0, FILE_HEAD_BYTES))?.format) {
    case 'GIF':
      return gifHasSecondImage(bytes);
    case 'PNG':
      return pngHasAnimationControl(bytes);
    case 'WebP':
      return webpHasAnimation(bytes);
    default:
      return false;
  }
}

/**
 * GIF（GIF89a 规范）在逻辑屏幕描述符之后是块序列：图像描述符（0x2C）跳过局部色表、LZW 码长与图像数据子块，扩展（0x21）
 * 跳过标签与数据子块，结尾（0x3B）或认不出的块停下。色表长度是 3 × 2^(N+1) 字节，N 是打包字段的低 3 位。
 */
function gifHasSecondImage(h: Uint8Array): boolean {
  let i = 13;
  if (h[10] & 0x80) i += 3 << ((h[10] & 0x07) + 1);
  let images = 0;
  while (i < h.length) {
    if (h[i] === 0x2c) {
      if (++images > 1) return true;
      const packed = h[i + 9];
      i += 10;
      if (packed & 0x80) i += 3 << ((packed & 0x07) + 1);
      i = skipSubBlocks(h, i + 1);
    } else if (h[i] === 0x21) {
      i = skipSubBlocks(h, i + 2);
    } else {
      return false;
    }
  }
  return false;
}

/** GIF 的数据子块：每块一字节长度后接数据，长度 0 结束；返回结束标记之后的位置 */
function skipSubBlocks(h: Uint8Array, i: number): number {
  while (i < h.length && h[i] !== 0) i += h[i] + 1;
  return i + 1;
}

/** PNG 的块：4 字节长度、4 字节类型、数据、4 字节 CRC；APNG 的动画控制块 acTL 必须在第一个 IDAT 之前 */
function pngHasAnimationControl(h: Uint8Array): boolean {
  for (let i = 8; i + 8 <= h.length; i += readUint32BE(h, i) + 12) {
    const type = ascii(h, i + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
  }
  return false;
}

/** WebP 的 RIFF 块：4 字节类型、4 字节小端长度、数据（奇数长度补一字节）；VP8X 的标志字节第 2 位是动画位 */
function webpHasAnimation(h: Uint8Array): boolean {
  if (hasAscii(h, 12, 'VP8X') && h.length > 20 && (h[20] & 0x02) !== 0) return true;
  for (let i = 12; i + 8 <= h.length; ) {
    const type = ascii(h, i, 4);
    if (type === 'ANIM' || type === 'ANMF') return true;
    const size = readUint32LE(h, i + 4);
    i += 8 + size + (size & 1);
  }
  return false;
}

/**
 * ZIP 里有没有这个条目：逐个找本地文件头，比对偏移 30 处的文件名；条目大小可能记在数据之后（数据描述符），
 * 所以不按大小跳
 */
function zipHasEntry(h: Uint8Array, name: string): boolean {
  for (let i = 0; i + 30 <= h.length; i++) {
    if (hasBytes(h, i, ZIP_LOCAL_HEADER) && (h[i + 26] | (h[i + 27] << 8)) === name.length && hasAscii(h, i + 30, name))
      return true;
  }
  return false;
}

/**
 * ISO 基础媒体文件（ISO/IEC 14496-12）按 ftyp 盒的品牌分类。AVIF 与 HEIF 在主品牌与兼容品牌里都找：
 * AVIF 文件的主品牌也可能写 mif1，avif 只列在兼容品牌里。M4A 与 MOV 只看主品牌：iTunes 的 M4V 视频
 * 会把 'M4A ' 列进兼容品牌。其余品牌（isom、mp41、mp42、3gp 系等）都归 MP4 家族的视频容器。
 */
function isoMediaFormat(h: Uint8Array): 'AVIF' | 'HEIC' | 'M4A' | 'MOV' | 'MP4' | null {
  if (h.length < 12 || !hasAscii(h, 4, 'ftyp')) return null;
  const major = ascii(h, 8, 4);
  const boxEnd = Math.min(readUint32BE(h, 0), h.length);
  const brands = [major];
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) brands.push(ascii(h, offset, 4));
  if (brands.some(b => AVIF_BRANDS.has(b))) return 'AVIF';
  if (brands.some(b => HEIF_BRANDS.has(b))) return 'HEIC';
  if (M4A_BRANDS.has(major)) return 'M4A';
  if (major === 'qt  ') return 'MOV';
  return 'MP4';
}

/**
 * Matroska 与 WebM 同为 EBML 容器（魔数 1A45DFA3），靠 DocType 元素（ID 0x4282）区分：
 * 与 file(1) 一样在文件头里找到它，跳过一字节长度后比对。
 */
function ebmlDocType(h: Uint8Array): 'webm' | 'matroska' | null {
  if (!hasBytes(h, 0, [0x1a, 0x45, 0xdf, 0xa3])) return null;
  for (let i = 4; i + 1 < h.length; i++) {
    if (h[i] !== 0x42 || h[i + 1] !== 0x82) continue;
    if (hasAscii(h, i + 3, 'webm')) return 'webm';
    if (hasAscii(h, i + 3, 'matroska')) return 'matroska';
    return null;
  }
  return null;
}

/** ID3v2 标签：'ID3' 后接主版本号（现有 2、3、4 三版）与不为 FF 的修订号。 */
function isId3v2(h: Uint8Array): boolean {
  return hasAscii(h, 0, 'ID3') && h.length >= 5 && h[3] >= 2 && h[3] <= 4 && h[4] !== 0xff;
}

/** MPEG 音频帧头：11 位同步，版本不为保留值 01，层为 Layer III（01），码率索引不为 1111，采样率索引不为 11。 */
function isMp3Frame(h: Uint8Array): boolean {
  if (h.length < 3 || h[0] !== 0xff || (h[1] & 0xe0) !== 0xe0) return false;
  const version = (h[1] >> 3) & 0x03;
  const layer = (h[1] >> 1) & 0x03;
  const bitrateIndex = h[2] >> 4;
  const sampleRateIndex = (h[2] >> 2) & 0x03;
  return version !== 0x01 && layer === 0x01 && bitrateIndex !== 0x0f && sampleRateIndex !== 0x03;
}

/** RIFF 容器：'RIFF' 加 4 字节长度，偏移 8 处是形式类型（WAVE、AVI 、WEBP）。 */
function isRiff(h: Uint8Array, formType: string): boolean {
  return hasAscii(h, 0, 'RIFF') && hasAscii(h, 8, formType);
}

function hasBytes(h: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (h.length < offset + bytes.length) return false;
  return bytes.every((b, i) => h[offset + i] === b);
}

function hasAscii(h: Uint8Array, offset: number, text: string): boolean {
  if (h.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (h[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function ascii(h: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...h.subarray(offset, offset + length));
}

function readUint32BE(h: Uint8Array, offset: number): number {
  return ((h[offset] << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3]) >>> 0;
}

function readUint32LE(h: Uint8Array, offset: number): number {
  return (h[offset] | (h[offset + 1] << 8) | (h[offset + 2] << 16) | (h[offset + 3] << 24)) >>> 0;
}

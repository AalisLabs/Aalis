// ============================================================
// @aalis/util-media-signature — 按文件头认定媒体格式
//
// 存储根里除了媒体，还有配置、令牌、记忆库、日志；只凭 kind 与路径发送，
// 这些文件会被当成图片发出去。发送附件的一方先读文件开头的字节，按下表的
// 格式签名认定格式，再决定放行、换一种方式发送还是拒发。
// 签名依据各格式的规范，并与 file(1) 的 magic 库对照（SILK 不在该库里）。
// 纯函数、无依赖，只用 Uint8Array。
// ============================================================

/** 可发送的附件类型。 */
export type MediaKind = 'image' | 'audio' | 'video';

/** 文件头认出的媒体格式：所属类型与格式名（如 PNG、M4A、MKV）。 */
export interface MediaFormat {
  kind: MediaKind;
  format: string;
}

/**
 * 认定格式要读的文件头长度：与 file(1) 在前 4 KiB 里找 Matroska DocType 的范围一致，也容得下 ftyp 盒的
 * 兼容品牌表；其余签名都在前 20 字节内。
 */
export const MEDIA_HEAD_BYTES = 4096;

const KIND_LABEL: Record<MediaKind, string> = { image: '图片', audio: '音频', video: '视频' };

/** BMP 偏移 14 处 DIB 头长度的合法取值（file(1) 认的各版本）；只有 'BM' 两字节太弱，文本也可能以它开头。 */
const BMP_DIB_HEADER_SIZES = new Set([12, 16, 24, 40, 48, 52, 56, 64, 108, 124]);
/** AMR 文件存储格式的魔数：单声道窄带、宽带与各自的多声道版本（RFC 4867 §5）。 */
const AMR_MAGICS = ['#!AMR\n', '#!AMR-WB\n', '#!AMR_MC1.0\n', '#!AMR-WB_MC1.0\n'];
const AVIF_BRANDS = new Set(['avif', 'avis']);
/** HEIF 的图片与图片序列品牌（ISO/IEC 23008-12）：HEVC 编码的 heic 系与通用的 mif1、msf1。 */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);
const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);

interface MediaSignature {
  kind: MediaKind;
  format: string;
  matches(head: Uint8Array): boolean;
}

const SIGNATURES: readonly MediaSignature[] = [
  { kind: 'image', format: 'PNG', matches: h => hasBytes(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  // SOI 标记 FFD8 之后紧跟下一个标记的 FF
  { kind: 'image', format: 'JPEG', matches: h => hasBytes(h, 0, [0xff, 0xd8, 0xff]) },
  { kind: 'image', format: 'GIF', matches: h => hasAscii(h, 0, 'GIF87a') || hasAscii(h, 0, 'GIF89a') },
  { kind: 'image', format: 'WebP', matches: h => isRiff(h, 'WEBP') },
  {
    kind: 'image',
    format: 'BMP',
    matches: h => hasAscii(h, 0, 'BM') && h.length >= 18 && BMP_DIB_HEADER_SIZES.has(readUint32LE(h, 14)),
  },
  { kind: 'image', format: 'AVIF', matches: h => isoMediaFormat(h) === 'AVIF' },
  { kind: 'image', format: 'HEIC', matches: h => isoMediaFormat(h) === 'HEIC' },
  { kind: 'audio', format: 'MP3', matches: h => isId3v2(h) || isMp3Frame(h) },
  { kind: 'audio', format: 'WAV', matches: h => isRiff(h, 'WAVE') },
  // 页头捕获模式 'OggS' 加结构版本 0（RFC 3533）
  { kind: 'audio', format: 'OGG', matches: h => hasBytes(h, 0, [0x4f, 0x67, 0x67, 0x53, 0x00]) },
  { kind: 'audio', format: 'FLAC', matches: h => hasAscii(h, 0, 'fLaC') },
  { kind: 'audio', format: 'AMR', matches: h => AMR_MAGICS.some(m => hasAscii(h, 0, m)) },
  // QQ 语音的 SILK 前面可能多一个 0x02
  {
    kind: 'audio',
    format: 'SILK',
    matches: h => hasAscii(h, 0, '#!SILK_V3') || (h[0] === 0x02 && hasAscii(h, 1, '#!SILK_V3')),
  },
  { kind: 'audio', format: 'M4A', matches: h => isoMediaFormat(h) === 'M4A' },
  { kind: 'video', format: 'MP4', matches: h => isoMediaFormat(h) === 'MP4' },
  { kind: 'video', format: 'MOV', matches: h => isoMediaFormat(h) === 'MOV' },
  { kind: 'video', format: 'WebM', matches: h => ebmlDocType(h) === 'webm' },
  { kind: 'video', format: 'MKV', matches: h => ebmlDocType(h) === 'matroska' },
  { kind: 'video', format: 'AVI', matches: h => isRiff(h, 'AVI ') },
];

/** 按文件头认定媒体格式；不是签名表里任何一种格式时返回 null。 */
export function detectMediaFormat(head: Uint8Array): MediaFormat | null {
  const detected = SIGNATURES.find(s => s.matches(head));
  return detected ? { kind: detected.kind, format: detected.format } : null;
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
    return `文件不是受支持的${KIND_LABEL[kind]}格式（${supported}），不能按 ${kind} 发送`;
  }
  if (detected.kind !== kind) {
    return `文件是 ${detected.format} ${KIND_LABEL[detected.kind]}，不能按 ${kind} 发送；请改用 kind=${detected.kind} 重新发送`;
  }
  return null;
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

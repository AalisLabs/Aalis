import { describe, expect, it } from 'vitest';
import {
  checkMediaHead,
  decodeUtf8Text,
  detectDocumentFormat,
  detectMediaFormat,
  isAnimatedImage,
  type MediaKind,
} from '../../packages/util-file-signature/src/index.js';
import {
  ascii,
  be32,
  bytes,
  chunk,
  FAKE_SQLITE,
  FAKE_TOKEN,
  FAKE_YAML,
  gif,
  le32,
  png,
  storedZip,
} from '../fixtures/file-heads.js';

// ════════════════════════════════════════════════════════════
// 按文件内容认定文件类型：媒体看文件头，文档、文本与动图看整份字节。扩展名、Content-Type 与 data URL 里写的类型都不看。
// 全部用手搓的最小字节（test/fixtures/file-heads.ts），内容为占位符。
// ════════════════════════════════════════════════════════════

/** ISO 基础媒体文件的 ftyp 盒：主品牌、次版本 0、兼容品牌表。 */
const ftyp = (major: string, ...compatible: string[]) =>
  bytes(be32(16 + 4 * compatible.length), 'ftyp', major, [0, 0, 0, 0], ...compatible);
/** EBML 头：版本字段后接 DocType（0x4282 + 一字节长度 + 名字）。 */
const ebml = (docType: string) =>
  bytes(
    [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01],
    [0x42, 0x82, 0x80 | docType.length],
    docType,
  );

/** 各格式的最小合法文件头，与判定出的扩展名、MIME。 */
const HEADS: Array<[format: string, kind: MediaKind, ext: string, mime: string, head: Uint8Array]> = [
  ['PNG', 'image', 'png', 'image/png', bytes([0x89], 'PNG\r\n', [0x1a, 0x0a], be32(13), 'IHDR')],
  ['JPEG', 'image', 'jpg', 'image/jpeg', bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0])],
  ['GIF', 'image', 'gif', 'image/gif', bytes('GIF89a', [1, 0, 1, 0, 0])],
  ['GIF', 'image', 'gif', 'image/gif', bytes('GIF87a', [1, 0, 1, 0, 0])],
  ['WebP', 'image', 'webp', 'image/webp', bytes('RIFF', le32(26), 'WEBP', 'VP8 ')],
  ['BMP', 'image', 'bmp', 'image/bmp', bytes('BM', le32(58), [0, 0, 0, 0], le32(54), le32(40))],
  ['AVIF', 'image', 'avif', 'image/avif', ftyp('avif', 'avif', 'mif1', 'miaf', 'MA1B')],
  ['AVIF', 'image', 'avif', 'image/avif', ftyp('mif1', 'mif1', 'avif', 'miaf')],
  ['HEIC', 'image', 'heic', 'image/heic', ftyp('heic', 'mif1', 'heic')],
  ['MP3', 'audio', 'mp3', 'audio/mpeg', bytes('ID3', [4, 0, 0, 0, 0, 0, 0])],
  ['MP3', 'audio', 'mp3', 'audio/mpeg', bytes([0xff, 0xfb, 0x90, 0x64])],
  ['MP3', 'audio', 'mp3', 'audio/mpeg', bytes([0xff, 0xf3, 0x48, 0xc4])],
  ['WAV', 'audio', 'wav', 'audio/wav', bytes('RIFF', le32(36), 'WAVE', 'fmt ')],
  ['OGG', 'audio', 'ogg', 'audio/ogg', bytes('OggS', [0, 2], [0, 0, 0, 0, 0, 0, 0, 0])],
  ['FLAC', 'audio', 'flac', 'audio/flac', bytes('fLaC', [0, 0, 0, 0x22])],
  ['AMR', 'audio', 'amr', 'audio/amr', bytes('#!AMR\n', [0x3c])],
  ['AMR', 'audio', 'amr', 'audio/amr', bytes('#!AMR-WB\n', [0x04])],
  ['SILK', 'audio', 'silk', 'audio/silk', bytes([0x02], '#!SILK_V3', [0x14, 0x00])],
  ['SILK', 'audio', 'silk', 'audio/silk', bytes('#!SILK_V3', [0x14, 0x00])],
  ['M4A', 'audio', 'm4a', 'audio/mp4', ftyp('M4A ', 'M4A ', 'mp42', 'isom')],
  ['MP4', 'video', 'mp4', 'video/mp4', ftyp('isom', 'isom', 'iso2', 'avc1', 'mp41')],
  ['MP4', 'video', 'mp4', 'video/mp4', ftyp('mp42', 'mp42', 'isom')],
  // iTunes 的 M4V 把 'M4A ' 列进兼容品牌：只看主品牌，仍是视频
  ['MP4', 'video', 'mp4', 'video/mp4', ftyp('M4V ', 'M4V ', 'M4A ', 'mp42', 'isom')],
  ['MOV', 'video', 'mov', 'video/quicktime', ftyp('qt  ', 'qt  ')],
  ['WebM', 'video', 'webm', 'video/webm', ebml('webm')],
  ['MKV', 'video', 'mkv', 'video/x-matroska', ebml('matroska')],
  ['AVI', 'video', 'avi', 'video/x-msvideo', bytes('RIFF', le32(4096), 'AVI ', 'LIST')],
];

const OTHER_KIND: Record<MediaKind, MediaKind> = { image: 'audio', audio: 'video', video: 'image' };

describe('detectMediaFormat 与 checkMediaHead：按文件头认媒体', () => {
  it.each(HEADS)('%s 按 %s 放行', (_format, kind, _ext, _mime, head) => {
    expect(checkMediaHead(head, kind)).toBeNull();
  });

  it.each(HEADS)('detectMediaFormat 认出 %s（%s），扩展名 %s、MIME %s', (format, kind, ext, mime, head) => {
    expect(detectMediaFormat(head)).toEqual({ kind, format, ext, mime });
  });

  it.each(HEADS)('%s 按别的 kind 发送：说出检测到的格式并指向正确的 kind', (format, kind, _ext, _mime, head) => {
    const message = checkMediaHead(head, OTHER_KIND[kind]);
    expect(message).toContain(`文件是 ${format} `);
    expect(message).toContain(`kind=${kind}`);
  });

  it.each([
    ['YAML 配置', bytes(FAKE_YAML)],
    ['令牌文本', bytes(FAKE_TOKEN)],
    ['SQLite 库', FAKE_SQLITE],
    ['JSON', bytes('{"users":[]}')],
    ['空文件', new Uint8Array(0)],
    ['以 BM 开头的文本', bytes('BMW owners, placeholder list\n')],
    ['以 ID3 开头的文本', bytes('ID3 tag notes\n')],
    ['以 #!AMR 开头但魔数不全的文本', bytes('#!AMRS notes\n')],
    ['AAC ADTS 帧（Layer 位为 00，不是 MP3）', bytes([0xff, 0xf1, 0x50, 0x80])],
    ['MPEG 帧同步但版本位为保留值', bytes([0xff, 0xeb, 0x90, 0x64])],
    ['MPEG Layer II 帧（不是 MP3）', bytes([0xff, 0xfd, 0x90, 0x64])],
    ['MPEG 帧但码率索引为保留值 1111', bytes([0xff, 0xfb, 0xf0, 0x64])],
    ['MPEG 帧但采样率索引为保留值 11', bytes([0xff, 0xfb, 0x9c, 0x64])],
    ['OggS 但结构版本不为 0', bytes('OggS', [1, 2], [0, 0, 0, 0, 0, 0, 0, 0])],
    ['FFD8 后不是标记', bytes([0xff, 0xd8, 0x00, 0x10])],
    ['PNG 签名不全', bytes([0x89], 'PNG', [0, 0, 0, 0])],
    ['GIF 版本不认识', bytes('GIF88a', [1, 0, 1, 0, 0])],
    ['以 fL 开头的文本', bytes('fLoat notes\n')],
    ['EBML 头但 DocType 不认识', ebml('other')],
    ['RIFF 但形式类型不认识', bytes('RIFF', le32(4), 'XXXX')],
  ])('%s：不是受支持的媒体，三种 kind 都拒', (_label, head) => {
    expect(checkMediaHead(head, 'image')).toBe(
      '文件不是受支持的图片格式（PNG、JPEG、GIF、WebP、BMP、AVIF、HEIC），不能按 image 发送',
    );
    expect(checkMediaHead(head, 'audio')).toBe(
      '文件不是受支持的音频格式（MP3、WAV、OGG、FLAC、AMR、SILK、M4A），不能按 audio 发送',
    );
    expect(checkMediaHead(head, 'video')).toBe(
      '文件不是受支持的视频格式（MP4、MOV、WebM、MKV、AVI），不能按 video 发送',
    );
    expect(detectMediaFormat(head)).toBeNull();
  });
});

describe('detectDocumentFormat：按内容认文档', () => {
  it('%PDF- 开头的是 PDF', () => {
    expect(detectDocumentFormat(bytes('%PDF-1.7\n%占位\n'))).toBe('PDF');
  });

  it('ZIP 里有 word/document.xml 条目的是 DOCX', () => {
    expect(detectDocumentFormat(storedZip({ '[Content_Types].xml': '', 'word/document.xml': '' }))).toBe('DOCX');
  });

  it('复合文档魔数（旧版 doc、xls、ppt）是 OLE', () => {
    expect(detectDocumentFormat(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], [0, 0, 0, 0]))).toBe('OLE');
  });

  it.each([
    ['没有 word/document.xml 的 ZIP（如 xlsx）', storedZip({ '[Content_Types].xml': '', 'xl/workbook.xml': '' })],
    ['不是 ZIP、正文里写着 word/document.xml 的文本', bytes('see word/document.xml\n')],
    ['PDF 魔数不全', bytes('%PD')],
    ['空文件', new Uint8Array(0)],
    ['PNG', HEADS[0][4]],
  ])('%s：不是文档', (_label, data) => {
    expect(detectDocumentFormat(data)).toBeNull();
  });
});

describe('decodeUtf8Text：只认 UTF-8 文本', () => {
  it('合法的 UTF-8 返回原文，去掉开头的 BOM', () => {
    expect(decodeUtf8Text(bytes('const a = 1;'))).toBe('const a = 1;');
    expect(decodeUtf8Text(new TextEncoder().encode('中文'))).toBe('中文');
    expect(decodeUtf8Text(bytes([0xef, 0xbb, 0xbf], 'a'))).toBe('a');
  });

  it('GBK 编码的中文与含 NUL 的字节不是文本', () => {
    // 「中文」的 GBK 编码
    expect(decodeUtf8Text(bytes([0xd6, 0xd0, 0xce, 0xc4]))).toBeNull();
    expect(decodeUtf8Text(bytes('a', [0], 'b'))).toBeNull();
  });
});

/** WebP 的 RIFF 块：类型、小端长度、数据（奇数长度补一字节） */
const riffChunk = (type: string, data: number[]) => [
  ...ascii(type),
  ...le32(data.length),
  ...data,
  ...(data.length & 1 ? [0] : []),
];
const webp = (...chunks: number[][]) => {
  const body = chunks.flat();
  return bytes('RIFF', le32(4 + body.length), 'WEBP', body);
};

describe('isAnimatedImage：多帧的 GIF、APNG 与动态 WebP', () => {
  it.each([
    ['两帧 GIF', gif(2)],
    ['IDAT 之前有 acTL 的 PNG（APNG）', png(chunk('acTL', [...be32(2), ...be32(0)]), chunk('IDAT', [0]))],
    ['VP8X 带动画位的 WebP', webp(riffChunk('VP8X', [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]))],
    [
      '带 ANIM 块的 WebP',
      webp(riffChunk('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), riffChunk('ANIM', [0, 0, 0, 0, 0, 0])),
    ],
  ])('%s 是动图', (_label, data) => {
    expect(isAnimatedImage(data)).toBe(true);
  });

  it.each([
    ['单帧 GIF', gif(1)],
    ['普通 PNG', png(chunk('IDAT', [0]))],
    ['acTL 在 IDAT 之后的 PNG', png(chunk('IDAT', [0]), chunk('acTL', [...be32(2), ...be32(0)]))],
    ['不带动画位的 WebP', webp(riffChunk('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), riffChunk('VP8 ', [0, 0]))],
    ['JPEG', HEADS[1][4]],
    ['空文件', new Uint8Array(0)],
  ])('%s 不是动图', (_label, data) => {
    expect(isAnimatedImage(data)).toBe(false);
  });
});

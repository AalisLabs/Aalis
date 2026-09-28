/** 纯字节净化。任何截断、结构不合规或无法核对的格式均抛错，由审核流水判 failed。 */

const utf8 = new TextDecoder('utf-8', { fatal: true });
const encode = new TextEncoder();
const ascii = (value: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...value.subarray(start, start + length));
const be32 = (value: Uint8Array, at: number) =>
  ((value[at] << 24) | (value[at + 1] << 16) | (value[at + 2] << 8) | value[at + 3]) >>> 0;
const le32 = (value: Uint8Array, at: number) =>
  (value[at] | (value[at + 1] << 8) | (value[at + 2] << 16) | (value[at + 3] << 24)) >>> 0;
function append(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    output.set(part, at);
    at += part.length;
  }
  return output;
}
const leBytes = (value: number) => Uint8Array.of(value, value >>> 8, value >>> 16, value >>> 24);
const bad = (): never => {
  throw new Error('文件结构不完整，无法剥离元数据');
};

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'iCCP', 'sRGB', 'gAMA', 'cHRM', 'pHYs']);

function png(source: Uint8Array): Uint8Array {
  const magic = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  if (source.length < 8 || magic.some((value, i) => source[i] !== value)) bad();
  const chunks: Uint8Array[] = [magic];
  let at = 8;
  let ihdr = false;
  let idat = false;
  let ended = false;
  while (at + 12 <= source.length) {
    const size = be32(source, at);
    if (size > source.length - at - 12) bad();
    const type = ascii(source, at + 4, 4);
    const after = at + 12 + size;
    if (crc32(source.subarray(at + 4, at + 8 + size)) !== be32(source, at + 8 + size)) bad();
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('动态 PNG 不能按静态图片审核');
    if (!ihdr && (type !== 'IHDR' || size !== 13)) bad();
    if (type === 'IHDR') {
      if (ihdr) bad();
      ihdr = true;
    }
    if (type === 'IDAT') idat = true;
    if (type === 'IEND') {
      if (size !== 0 || !idat) bad();
      ended = true;
      chunks.push(source.slice(at, after));
      break;
    }
    if (!PNG_KEEP.has(type) && type[0] === type[0].toUpperCase()) bad();
    if (PNG_KEEP.has(type)) chunks.push(source.slice(at, after));
    at = after;
  }
  if (!ended) bad();
  return append(...chunks);
}

function jpeg(source: Uint8Array): Uint8Array {
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) bad();
  const parts: Uint8Array[] = [source.slice(0, 2)];
  let at = 2;
  let scan = false;
  while (at < source.length) {
    if (source[at] !== 0xff) bad();
    const start = at;
    while (source[at] === 0xff) at++;
    if (at >= source.length) bad();
    const marker = source[at++];
    if (marker === 0xd9) {
      parts.push(source.slice(start, at));
      return append(...parts);
    }
    if (marker === 0xd8 || marker === 0x00) bad();
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (!scan) bad();
      parts.push(source.slice(start, at));
      continue;
    }
    if (at + 2 > source.length) bad();
    const size = source[at] * 256 + source[at + 1];
    if (size < 2 || at + size > source.length) bad();
    const end = at + size;
    const keep = marker < 0xe0 || marker > 0xef || [0xe0, 0xe2, 0xee].includes(marker);
    if (keep && marker !== 0xfe) parts.push(source.slice(start, end));
    at = end;
    if (marker !== 0xda) continue;
    scan = true;
    const dataStart = at;
    while (at + 1 < source.length) {
      if (source[at] !== 0xff || source[at + 1] === 0x00) {
        at += source[at] === 0xff ? 2 : 1;
        continue;
      }
      if (source[at + 1] === 0xff) {
        at++;
        continue;
      }
      if (source[at + 1] >= 0xd0 && source[at + 1] <= 0xd7) {
        at += 2;
        continue;
      }
      parts.push(source.slice(dataStart, at));
      break;
    }
  }
  return bad();
}

function gifSubblocks(source: Uint8Array, start: number): number {
  let at = start;
  while (at < source.length) {
    const size = source[at++];
    if (size === 0) return at;
    if (at + size > source.length) bad();
    at += size;
  }
  return bad();
}

function gif(source: Uint8Array): Uint8Array {
  const header = ascii(source, 0, 6);
  if (!['GIF87a', 'GIF89a'].includes(header) || source.length < 13) bad();
  let at = 13;
  if (source[10] & 0x80) at += 3 * 2 ** ((source[10] & 7) + 1);
  if (at > source.length) bad();
  const parts: Uint8Array[] = [source.slice(0, at)];
  let image = false;
  while (at < source.length) {
    const start = at;
    const block = source[at++];
    if (block === 0x3b) {
      if (!image) bad();
      parts.push(source.slice(start, at));
      return append(...parts);
    }
    if (block === 0x2c) {
      if (at + 9 > source.length) bad();
      const flags = source[at + 8];
      at += 9;
      if (flags & 0x80) at += 3 * 2 ** ((flags & 7) + 1);
      if (at >= source.length) bad();
      at = gifSubblocks(source, at + 1);
      parts.push(source.slice(start, at));
      image = true;
      continue;
    }
    if (block !== 0x21 || at >= source.length) bad();
    const kind = source[at++];
    if (kind === 0xf9) {
      if (source[at] !== 4 || at + 6 > source.length || source[at + 5] !== 0) bad();
      at += 6;
      parts.push(source.slice(start, at));
      continue;
    }
    if (at >= source.length) bad();
    const firstSize = source[at++];
    if (at + firstSize > source.length) bad();
    const app = kind === 0xff ? ascii(source, at, firstSize) : '';
    at = gifSubblocks(source, at + firstSize);
    if (kind === 0xff && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(app)) parts.push(source.slice(start, at));
  }
  return bad();
}

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP']);

function webp(source: Uint8Array): Uint8Array {
  if (source.length < 20 || ascii(source, 0, 4) !== 'RIFF' || ascii(source, 8, 4) !== 'WEBP') bad();
  const end = le32(source, 4) + 8;
  if (end > source.length || end < 20) bad();
  const chunks: Uint8Array[] = [];
  let image = false;
  for (let at = 12; at < end; ) {
    if (at + 8 > end) bad();
    const type = ascii(source, at, 4);
    const size = le32(source, at + 4);
    const next = at + 8 + size + (size & 1);
    if (next > end) bad();
    if (type === 'ANIM' || type === 'ANMF') throw new Error('动态 WebP 不能按静态图片审核');
    if (type === 'VP8X' && source[at + 8] & 0x02) throw new Error('动态 WebP 不能按静态图片审核');
    if (type === 'VP8 ' || type === 'VP8L') image = true;
    if (WEBP_KEEP.has(type)) {
      const chunk = source.slice(at, next);
      if (type === 'VP8X') chunk[8] &= ~0x0c;
      chunks.push(chunk);
    }
    at = next;
  }
  if (!image) bad();
  const body = append(...chunks);
  return append(asciiBytes('RIFF'), leBytes(body.length + 4), asciiBytes('WEBP'), body);
}

function asciiBytes(text: string): Uint8Array {
  return encode.encode(text);
}

function svg(source: Uint8Array): Uint8Array {
  let text: string;
  try {
    text = utf8.decode(source);
  } catch {
    return bad();
  }
  if (!/<svg\b/i.test(text)) bad();
  const tag = '(?:[a-z][\\w.-]*:)?metadata';
  const open = (text.match(new RegExp(`<${tag}\\b`, 'gi')) ?? []).length;
  const closed = (text.match(new RegExp(`<\\/${tag}\\s*>`, 'gi')) ?? []).length;
  const selfClosed = (text.match(new RegExp(`<${tag}\\b[^>]*\\/\\s*>`, 'gi')) ?? []).length;
  if (open !== closed + selfClosed) bad();
  const cleaned = text
    .replace(new RegExp(`<${tag}\\b[^>]*>[^]*?<\\/${tag}\\s*>`, 'gi'), '')
    .replace(new RegExp(`<${tag}\\b[^>]*\\/\\s*>`, 'gi'), '');
  if (new RegExp(`<\\/?${tag}\\b`, 'i').test(cleaned)) bad();
  return encode.encode(cleaned);
}

export function stripStaticMedia(ext: string, source: Uint8Array): Uint8Array {
  if (ext === 'png') return png(source);
  if (ext === 'jpg' || ext === 'jpeg') return jpeg(source);
  if (ext === 'gif') return gif(source);
  if (ext === 'webp') return webp(source);
  if (ext === 'svg') return svg(source);
  throw new TypeError('不支持的静态媒体格式');
}

interface EmbeddedResult {
  text: string;
  images: Array<{ mime: string; bytes: Uint8Array }>;
}

/** 仅处理文本中字面存在的 data URL；无法净化的位图/视频非 base64 写法直接失败关闭。 */
export async function stripEmbeddedDataUrls(
  source: string,
  strip: (mime: string, bytes: Uint8Array) => Promise<Uint8Array>,
  depth = 0,
): Promise<EmbeddedResult> {
  if (depth > 4) throw new Error('内嵌媒体层数过多，无法完整审核');
  const pattern = /data:(image\/(?:png|jpeg|gif|webp|svg\+xml)|video\/mp4)((?:;[^,\s"'<>)]*)?),([^\s"'<>)]*)/gi;
  const candidatePattern = /data:(?:image\/(?:png|jpeg|gif|webp|svg\+xml)|video\/mp4)/gi;
  const candidates = [...source.matchAll(candidatePattern)];
  // Chrome resolves HTML entities and CSS escapes before loading URL-valued attributes.
  // If decoding reveals a data URL that the byte-preserving rewriter cannot locate, reject it.
  const shadow = source
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_all, digits: string) => {
      const value =
        digits[0].toLowerCase() === 'x' ? Number.parseInt(digits.slice(1), 16) : Number.parseInt(digits, 10);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    })
    .replace(/&colon;?/gi, ':')
    .replace(/&(?:tab|newline);?/gi, '')
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?/gi, (_all, digits: string) => {
      const value = Number.parseInt(digits, 16);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    })
    .replace(/\\([^0-9a-f\n\r\f])/gi, '$1');
  if ([...shadow.matchAll(candidatePattern)].length > candidates.length)
    throw new Error('编码的内嵌媒体网址无法安全净化');
  const matches = [...source.matchAll(pattern)];
  if (candidates.length !== matches.length) throw new Error('内嵌媒体网址无法解析');
  const images: EmbeddedResult['images'] = [];
  let text = '';
  let at = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    text += source.slice(at, index);
    const mime = match[1].toLowerCase();
    const params = match[2].toLowerCase().split(';').filter(Boolean);
    if (
      params.some(param => !['base64', 'charset=utf-8', 'utf8'].includes(param)) ||
      params.filter(param => param === 'base64').length > 1
    )
      throw new Error('内嵌媒体网址参数无法解析');
    const base64 = params.includes('base64');
    if (!base64 && mime !== 'image/svg+xml') throw new Error('内嵌媒体不是 base64，无法净化');
    let decoded: Uint8Array;
    try {
      if (base64) {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(match[3])) bad();
        decoded = Buffer.from(match[3], 'base64');
      } else decoded = encode.encode(decodeURIComponent(match[3]));
    } catch {
      return bad();
    }
    let cleaned = await strip(mime, decoded);
    if (mime === 'image/svg+xml') {
      const nested = await stripEmbeddedDataUrls(utf8.decode(cleaned), strip, depth + 1);
      cleaned = encode.encode(nested.text);
      images.push(...nested.images);
    }
    images.push({ mime, bytes: cleaned });
    text += `data:${mime};base64,${Buffer.from(cleaned).toString('base64')}`;
    at = index + match[0].length;
  }
  text += source.slice(at);
  return { text, images };
}

// ════════════════════════════════════════════════════════════
// 按内容判文件类型的用例共用的最小文件字节：按各格式的规范手搓，内容为占位符。
// ════════════════════════════════════════════════════════════

export const ascii = (s: string) => [...s].map(c => c.charCodeAt(0));
export const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
export const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
export const be32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
export const bytes = (...parts: Array<number[] | string>) =>
  Uint8Array.from(parts.flatMap(p => (typeof p === 'string' ? ascii(p) : p)));

/** GIF：逻辑屏幕带 2 色全局色表，frames 张 1×1 的图像，每张之前一个图形控制扩展；开头另有一个应用扩展（循环次数） */
export function gif(frames: number): Uint8Array {
  const image = [
    [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00],
    [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00],
    [0x02, 0x02, 0x44, 0x01, 0x00],
  ];
  return bytes(
    'GIF89a',
    [1, 0, 1, 0, 0x80, 0, 0],
    [0, 0, 0, 0xff, 0xff, 0xff],
    [0x21, 0xff, 0x0b],
    'NETSCAPE2.0',
    [0x03, 0x01, 0x00, 0x00, 0x00],
    ...Array.from({ length: frames }, () => image).flat(),
    [0x3b],
  );
}

/** PNG 块：长度、类型、数据、CRC（判定不看 CRC，填 0） */
export const chunk = (type: string, data: number[] = []) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
/** PNG：签名、1×1 的 IHDR、给出的块与 IEND */
export const png = (...chunks: number[][]) =>
  bytes(
    [0x89],
    'PNG\r\n',
    [0x1a, 0x0a],
    chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    ...chunks,
    chunk('IEND'),
  );

/** CRC-32（ZIP 用的多项式 0xEDB88320） */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 不压缩的 ZIP：各条目依次是本地文件头与内容，末尾是中央目录（mammoth 按中央目录找条目） */
export function storedZip(entries: Record<string, string | Uint8Array>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const fileName = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(fileName.length, 28);
    record.writeUInt32LE(offset, 42);
    parts.push(local, fileName, data);
    central.push(record, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** 存储根里常见的非媒体文件（内容均为占位符）。 */
export const FAKE_YAML = 'server:\n  token: PLACEHOLDER-TOKEN\n  port: 0\n';
export const FAKE_TOKEN = 'sk-PLACEHOLDER-0000000000000000\n';
export const FAKE_SQLITE = bytes('SQLite format 3', [0], [0x10, 0x00, 0x01, 0x01]);

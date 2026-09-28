import { describe, expect, it } from 'vitest';
import { stripEmbeddedDataUrls, stripStaticMedia } from '../../packages/plugin-publish-review/src/strip/index.js';

const encoder = new TextEncoder();
const ascii = (value: string) => encoder.encode(value);
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(part => [...part]));
const be32 = (value: number) => Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);

function crc(bytes: Uint8Array): number {
  let value = -1;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ -1) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const payload = join(ascii(type), body);
  return join(be32(body.length), payload, be32(crc(payload)));
}

const png = (...extra: Uint8Array[]) =>
  join(
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0)),
    ...extra,
    chunk('IDAT', Uint8Array.of(1, 2, 3)),
    chunk('IEND', new Uint8Array()),
  );

describe('作品文件剥元数据', () => {
  it('PNG 删 tEXt 和未知块，保留 IDAT 并截尾；畸形与动态 PNG 失败关闭', () => {
    const source = join(png(chunk('tEXt', ascii('GPS=secret')), chunk('zzzz', ascii('hidden'))), ascii('TAIL'));
    const result = stripStaticMedia('png', source);
    const asText = new TextDecoder('latin1').decode(result);
    expect(asText).not.toContain('GPS=secret');
    expect(asText).not.toContain('hidden');
    expect(asText).not.toContain('TAIL');
    expect(asText).toContain('IDAT');
    expect(() => stripStaticMedia('png', source.slice(0, 20))).toThrow();
    expect(() => stripStaticMedia('png', png(chunk('acTL', Uint8Array.of(0, 0, 0, 2))))).toThrow();
  });

  it('JPEG 去 APP1/COM 保留图像扫描字节，截掉 EOI 后尾巴', () => {
    const segment = (marker: number, data: Uint8Array) => join(Uint8Array.of(255, marker, 0, data.length + 2), data);
    const image = join(
      Uint8Array.of(255, 216),
      segment(0xe1, ascii('GPS=secret')),
      segment(0xdb, Uint8Array.of(7)),
      segment(0xda, Uint8Array.of(1)),
      Uint8Array.of(4, 5, 255, 0, 6, 255, 217),
      ascii('TAIL'),
    );
    const result = stripStaticMedia('jpeg', image);
    expect(new TextDecoder('latin1').decode(result)).not.toContain('GPS=secret');
    expect([...result.slice(-8)]).toEqual([1, 4, 5, 255, 0, 6, 255, 217]);
  });

  it('SVG 去 metadata；网页内嵌 base64 JPEG 原位替换，非 base64 位图失败', async () => {
    const svg = ascii('<svg><metadata>private</metadata><rect width="1"/></svg>');
    expect(new TextDecoder().decode(stripStaticMedia('svg', svg))).toBe('<svg><rect width="1"/></svg>');
    expect(() =>
      stripStaticMedia('svg', ascii('<svg><metadata><metadata>x</metadata>GPS-secret</metadata><rect/></svg>')),
    ).toThrow();
    expect(
      new TextDecoder().decode(stripStaticMedia('svg', ascii('<svg><s:metadata>private</s:metadata></svg>'))),
    ).toBe('<svg></svg>');
    const jpeg = Uint8Array.of(255, 216, 255, 217);
    const text = `x=data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
    const stripped = await stripEmbeddedDataUrls(text, async (_mime, bytes) => bytes);
    expect(stripped.text).toContain('data:image/jpeg;base64,');
    expect(stripped.images).toHaveLength(1);
    await expect(stripEmbeddedDataUrls('url(data:image/png,%89PNG)', async (_mime, bytes) => bytes)).rejects.toThrow();
    await expect(
      stripEmbeddedDataUrls('data:image/png;charset=x;base64,AAAA', async (_mime, bytes) => bytes),
    ).rejects.toThrow();
    await expect(
      stripEmbeddedDataUrls('src="data&#58;image/jpeg;base64,AAAA"', async (_mime, bytes) => bytes),
    ).rejects.toThrow();
    await expect(
      stripEmbeddedDataUrls('url(data\\3a image/png;base64,AAAA)', async (_mime, bytes) => bytes),
    ).rejects.toThrow();
    const encodedSvg = await stripEmbeddedDataUrls(
      'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E',
      async (_mime, bytes) => bytes,
    );
    expect(encodedSvg.text).toContain('data:image/svg+xml;base64,');
    const nested = `<svg><image href="data:image/png;base64,${Buffer.from(png(chunk('tEXt', ascii('GPS=secret')))).toString('base64')}"/></svg>`;
    const outer = `data:image/svg+xml;base64,${Buffer.from(nested).toString('base64')}`;
    const recursive = await stripEmbeddedDataUrls(outer, async (mime, bytes) =>
      stripStaticMedia(mime === 'image/svg+xml' ? 'svg' : 'png', bytes),
    );
    expect(recursive.images).toHaveLength(2);
    expect(new TextDecoder('latin1').decode(recursive.images[0].bytes)).not.toContain('GPS=secret');
  });

  it('GIF 删除注释、纯文本与 XMP 应用块，保留循环扩展并截尾', () => {
    const header = join(ascii('GIF89a'), Uint8Array.of(1, 0, 1, 0, 0, 0, 0));
    const app = (name: string) => join(Uint8Array.of(0x21, 0xff, 11), ascii(name), Uint8Array.of(1, 1, 0));
    const source = join(
      header,
      Uint8Array.of(0x21, 0xfe, 3),
      ascii('GPS'),
      Uint8Array.of(0),
      app('XMP DataXMP'),
      app('NETSCAPE2.0'),
      Uint8Array.of(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0, 0, 0x3b),
      ascii('TAIL'),
    );
    const result = new TextDecoder('latin1').decode(stripStaticMedia('gif', source));
    expect(result).not.toContain('GPS');
    expect(result).not.toContain('XMP DataXMP');
    expect(result).toContain('NETSCAPE2.0');
    expect(result).not.toContain('TAIL');
  });

  it('WebP 清 EXIF/XMP 与 VP8X 标志、截尾；动画拒收', () => {
    const le32 = (n: number) => Uint8Array.of(n, n >>> 8, n >>> 16, n >>> 24);
    const webpChunk = (name: string, payload: Uint8Array) =>
      join(ascii(name), le32(payload.length), payload, payload.length % 2 ? Uint8Array.of(0) : new Uint8Array());
    const vp8x = webpChunk('VP8X', Uint8Array.of(0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0));
    const body = join(
      vp8x,
      webpChunk('EXIF', ascii('GPS')),
      webpChunk('XMP ', ascii('private')),
      webpChunk('VP8 ', Uint8Array.of(1, 2)),
    );
    const source = join(ascii('RIFF'), le32(body.length + 4), ascii('WEBP'), body, ascii('TAIL'));
    const result = stripStaticMedia('webp', source);
    expect(new TextDecoder('latin1').decode(result)).not.toContain('private');
    expect(result[20] & 0x0c).toBe(0);
    expect(new TextDecoder('latin1').decode(result)).not.toContain('TAIL');
    const animated = source.slice();
    animated[20] = 0x02;
    expect(() => stripStaticMedia('webp', animated)).toThrow();
  });
});

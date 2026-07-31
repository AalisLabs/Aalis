import { describe, expect, it } from 'vitest';
import { readTailLines, type StorageService } from '../../packages/api-storage/src/index.js';

/** 内存文件伪 storage:可选是否提供 readFileRange(测回退路径) */
function fakeStorage(content: string, withRange = true): StorageService {
  const data = Buffer.from(content, 'utf8');
  const svc = {
    stat: async () => ({ size: data.length }) as never,
    readFile: async () => content,
    ...(withRange
      ? { readFileRange: async (_u: string, start: number, end: number) => data.subarray(start, end) }
      : {}),
  };
  return svc as unknown as StorageService;
}

/** 朴素参照实现:整文件切行 */
function naiveTail(content: string, n: number, filter?: (l: string) => boolean): string[] {
  let lines = content.split('\n').filter(l => l.length > 0);
  if (filter) lines = lines.filter(filter);
  return lines.slice(-n);
}

describe('readTailLines', () => {
  it('与整文件实现结果一致(中英混合、长短行)', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(
        i % 3 === 0
          ? `${i} 2026-07-23T10:00:00.000Z INFO 测试域 这是一条中文日志消息,编号 ${i},含标点。`
          : `${i} short ascii line #${i} ${'x'.repeat(i % 50)}`,
      );
    }
    const content = `${lines.join('\n')}\n`;
    const got = await readTailLines(fakeStorage(content), 'logs:/latest.log', 50);
    expect(got).toEqual(naiveTail(content, 50));
  });

  it('小块强制切割多字节字符:无乱码、字节级精确', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `第${i}行:中文内容✨emoji与多字节字符测试`);
    const content = `${lines.join('\n')}\n`;
    // chunkSize 会被钳到 ≥4096,用长行+小上限逼出跨块路径:拼一条超过 4096 字节的中文行
    const long = `LONG ${'汉'.repeat(3000)} END`;
    const content2 = `${lines.join('\n')}\n${long}\n${lines.join('\n')}\n`;
    const got = await readTailLines(fakeStorage(content2), 'u', 100);
    expect(got).toEqual(naiveTail(content2, 100));
    expect(got.some(l => l.includes('�'))).toBe(false); // 无 replacement char
    const got1 = await readTailLines(fakeStorage(content), 'u', 10);
    expect(got1).toEqual(naiveTail(content, 10));
  });

  it('filter 计数与返回(seq 分页语义)', async () => {
    const content = `${Array.from({ length: 100 }, (_, i) => `${i} entry-${i}`).join('\n')}\n`;
    const before = 60;
    const f = (l: string) => Number(l.split(' ')[0]) < before;
    const got = await readTailLines(fakeStorage(content), 'u', 10, { filter: f });
    expect(got).toEqual(naiveTail(content, 10, f));
    expect(got[got.length - 1]).toBe('59 entry-59');
  });

  it('提供者无 readFileRange 时回退整文件,结果一致', async () => {
    const content = `${Array.from({ length: 30 }, (_, i) => `line ${i} 中文${i}`).join('\n')}\n`;
    const got = await readTailLines(fakeStorage(content, false), 'u', 7);
    expect(got).toEqual(naiveTail(content, 7));
  });

  it('maxBytes 截断:只返回完整行、不超过 maxLines、不含半行乱码', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `${i} ${'内容'.repeat(20)}`);
    const content = `${lines.join('\n')}\n`;
    const got = await readTailLines(fakeStorage(content), 'u', 4000, { maxBytes: 64 * 1024 });
    expect(got.length).toBeLessThanOrEqual(4000);
    expect(got.length).toBeGreaterThan(0);
    // 返回的每一行都必须是文件中真实存在的完整行
    const all = new Set(lines);
    for (const l of got) expect(all.has(l)).toBe(true);
    // 且是连续的尾部
    expect(got[got.length - 1]).toBe(lines[lines.length - 1]);
  });

  it('文件不存在返回空数组', async () => {
    const svc = {
      stat: async () => {
        throw new Error('no');
      },
    } as unknown as StorageService;
    expect(await readTailLines(svc, 'u', 10)).toEqual([]);
  });
});

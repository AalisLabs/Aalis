import { describe, expect, it, vi } from 'vitest';
import { formatImageSection, recognizeImages } from '../../packages/plugin-file-reader/src/doc-images.js';

// ════════════════════════════════════════════════════════════
// file-reader 文档内嵌图片识别 —— 纯编排逻辑
// ════════════════════════════════════════════════════════════

describe('recognizeImages', () => {
  it('逐张识别、保持顺序、trim（并发 1）', async () => {
    const out = await recognizeImages(['a', 'b'], async u => `desc-${u} `, { maxImages: 10, concurrency: 1 });
    expect(out).toEqual(['desc-a', 'desc-b']);
  });

  it('按 maxImages 截断（只识别前 N 张）', async () => {
    const describe = vi.fn(async (u: string) => `d-${u}`);
    const out = await recognizeImages(['a', 'b', 'c', 'd'], describe, { maxImages: 2 });
    expect(out).toEqual(['d-a', 'd-b']);
    expect(describe).toHaveBeenCalledTimes(2); // 超出的不调用识别
  });

  it('maxImages<=0 → 不识别', async () => {
    const describe = vi.fn(async () => 'x');
    expect(await recognizeImages(['a'], describe, { maxImages: 0 })).toEqual([]);
    expect(describe).not.toHaveBeenCalled();
  });

  it('单张失败（抛错）跳过，不影响其余', async () => {
    const out = await recognizeImages(
      ['a', 'b', 'c'],
      async u => {
        if (u === 'b') throw new Error('vision down');
        return `d-${u}`;
      },
      { maxImages: 10, concurrency: 1 },
    );
    expect(out).toEqual(['d-a', 'd-c']);
  });

  it('空/空白描述被丢弃', async () => {
    const out = await recognizeImages(['a', 'b', 'c'], async u => (u === 'b' ? '   ' : `d-${u}`), {
      maxImages: 10,
      concurrency: 1,
    });
    expect(out).toEqual(['d-a', 'd-c']);
  });

  it('并发执行（concurrency>1 时多张同时在飞）+ 保序', async () => {
    let active = 0;
    let peak = 0;
    const out = await recognizeImages(
      ['a', 'b', 'c', 'd'],
      async u => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 15));
        active--;
        return `d-${u}`;
      },
      { maxImages: 10, concurrency: 3 },
    );
    expect(out).toEqual(['d-a', 'd-b', 'd-c', 'd-d']); // 保序
    expect(peak).toBeGreaterThanOrEqual(2); // 确有并发
  });

  it('整体超时 → 返回已完成的部分（不卡在慢调用上）', async () => {
    const out = await recognizeImages(
      ['fast', 'slow'],
      async u => {
        if (u === 'slow') await new Promise(r => setTimeout(r, 1000));
        return `d-${u}`;
      },
      { maxImages: 10, concurrency: 1, timeoutMs: 50 },
    );
    expect(out).toEqual(['d-fast']); // slow 未在预算内完成，被丢弃
  });
});

describe('formatImageSection', () => {
  it('无描述 → 空串（不追加小节）', () => {
    expect(formatImageSection([])).toBe('');
  });

  it('多条 → 编号小节', () => {
    expect(formatImageSection(['一只猫', '一张图表'])).toBe(
      '\n\n--- 文档内图片 (2) ---\n[图片1: 一只猫]\n[图片2: 一张图表]',
    );
  });
});

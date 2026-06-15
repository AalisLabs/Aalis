import { describe, expect, it, vi } from 'vitest';
import { formatImageSection, recognizeImages } from '../../packages/plugin-file-reader/src/doc-images.js';

// ════════════════════════════════════════════════════════════
// file-reader 文档内嵌图片识别 —— 纯编排逻辑
// ════════════════════════════════════════════════════════════

describe('recognizeImages', () => {
  it('逐张识别、保持顺序、trim', async () => {
    const out = await recognizeImages(['a', 'b'], async u => `desc-${u} `, 10);
    expect(out).toEqual(['desc-a', 'desc-b']);
  });

  it('按 maxImages 截断（只识别前 N 张）', async () => {
    const describe = vi.fn(async (u: string) => `d-${u}`);
    const out = await recognizeImages(['a', 'b', 'c', 'd'], describe, 2);
    expect(out).toEqual(['d-a', 'd-b']);
    expect(describe).toHaveBeenCalledTimes(2); // 超出的不调用识别
  });

  it('maxImages<=0 → 不识别', async () => {
    const describe = vi.fn(async () => 'x');
    expect(await recognizeImages(['a'], describe, 0)).toEqual([]);
    expect(describe).not.toHaveBeenCalled();
  });

  it('单张失败（抛错）跳过，不影响其余', async () => {
    const out = await recognizeImages(
      ['a', 'b', 'c'],
      async u => {
        if (u === 'b') throw new Error('vision down');
        return `d-${u}`;
      },
      10,
    );
    expect(out).toEqual(['d-a', 'd-c']);
  });

  it('空/空白描述被丢弃', async () => {
    const out = await recognizeImages(['a', 'b', 'c'], async u => (u === 'b' ? '   ' : `d-${u}`), 10);
    expect(out).toEqual(['d-a', 'd-c']);
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

import { describe, expect, it } from 'vitest';
import { isStorageNotFound } from '../../packages/api-storage/src/index.js';

// ════════════════════════════════════════════════════════════
// 「目标不存在」判据：整份读入再整份回写的消费者据它区分「全新」与「读不出」。
// 曾在各包各抄一份，有的只看文案：带 EACCES 等 code、文案（路径、提供者措辞）里恰好有
// not found 的错误被当成「不存在」，于是按全新处理、下一次写把读不出的原文件整份覆盖。
// 契约：有 code 只认 ENOENT；没有 code 才退回文案。
// ════════════════════════════════════════════════════════════

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('isStorageNotFound', () => {
  it('code 为 ENOENT → 不存在（文案无关）', () => {
    expect(isStorageNotFound(coded('ENOENT', '文件缺失'))).toBe(true);
    expect(isStorageNotFound({ code: 'ENOENT' })).toBe(true);
  });

  it('有 code 但不是 ENOENT → 不算不存在，即使文案含 not found / 不存在 / ENOENT', () => {
    expect(isStorageNotFound(coded('EACCES', "EACCES: credentials not found, open 'data:/x.json'"))).toBe(false);
    expect(isStorageNotFound(coded('EISDIR', '目标不存在或是目录'))).toBe(false);
    expect(isStorageNotFound(coded('EIO', 'ENOENT-like cache miss'))).toBe(false);
  });

  it('没有 code 时退回文案：ENOENT / not found / 不存在（不分大小写）', () => {
    expect(isStorageNotFound(new Error("ENOENT: no such file or directory, open '/x'"))).toBe(true);
    expect(isStorageNotFound(new Error('Object Not Found'))).toBe(true);
    expect(isStorageNotFound(new Error('文件不存在'))).toBe(true);
    expect(isStorageNotFound({ message: 'key not found' })).toBe(true);
    expect(isStorageNotFound('ENOENT')).toBe(true);
  });

  it('没有 code 且文案不命中 → 读失败而非不存在（含网关的「未知存储根」）', () => {
    expect(isStorageNotFound(new Error('未知存储根: data（已注册根: (无), 需能力 [read]）'))).toBe(false);
    expect(isStorageNotFound(new Error('EACCES: permission denied'))).toBe(false);
    expect(isStorageNotFound(null)).toBe(false);
    expect(isStorageNotFound(undefined)).toBe(false);
  });
});

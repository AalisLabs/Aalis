// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStored, writeStored } from '../../packages/plugin-webui-client/src/storage.js';

// 浏览器存储只经这一个模块：读写失败（隐私模式、封装禁用存储）一律按没存过处理，页面照常可用

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('浏览器存储', () => {
  it('按 JSON 存取，键带 aalis. 前缀', () => {
    writeStored('panels', { left: false });
    expect(localStorage.getItem('aalis.panels')).toBe('{"left":false}');
    expect(readStored('panels')).toEqual({ left: false });
  });

  it('没存过、存坏了的都读成 undefined', () => {
    expect(readStored('panels')).toBeUndefined();
    localStorage.setItem('aalis.panels', '{坏');
    expect(readStored('panels')).toBeUndefined();
  });

  it('存储不可用时读成 undefined，写入不抛错', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(readStored('panels')).toBeUndefined();
    expect(() => writeStored('panels', { left: true })).not.toThrow();
  });
});

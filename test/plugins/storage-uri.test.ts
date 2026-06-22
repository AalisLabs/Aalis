import { describe, expect, it } from 'vitest';
import { isStorageUri, parseUriRoot, toStorageUri } from '../../packages/plugin-storage-api/src/index.js';

// ════════════════════════════════════════════════════════════
// storage URI 权威文法（isStorageUri / parseUriRoot）—— 收口 onebot/media/asr 6 处重抄。
// 关键：data:/（storage 根 data）vs data:<mime>;base64,（标准 data-URI）必须分清，
// 否则真 data:/ 附件被误当 data-URI → 解码失败返回 null（旧 blind-spot）。
// ════════════════════════════════════════════════════════════

describe('isStorageUri', () => {
  it('storage URI（<root>:/path）→ true', () => {
    expect(isStorageUri('data:/images/x.jpg')).toBe(true);
    expect(isStorageUri('workspace:/notes.md')).toBe(true);
    expect(isStorageUri('tmp:/build/out')).toBe(true);
    expect(isStorageUri('pluginData:/file-reader/a.json')).toBe(true);
    expect(isStorageUri('share:/x')).toBe(true); // 任意自定义根名
  });

  it('data: 歧义：data:/（storage）vs data:<mime>;base64,（data-URI）', () => {
    expect(isStorageUri('data:/images/x.jpg')).toBe(true); // 冒号后紧跟 / → storage
    expect(isStorageUri('data:image/png;base64,iVBORw0KGgo=')).toBe(false); // 冒号后 MIME → data-URI
    expect(isStorageUri('data:text/plain;base64,QQ==')).toBe(false);
  });

  it('保留 scheme（http/https/file）→ false', () => {
    expect(isStorageUri('http://h/x')).toBe(false);
    expect(isStorageUri('https://gchat.qpic.cn/x.jpg')).toBe(false);
    expect(isStorageUri('file:///etc/passwd')).toBe(false);
  });

  it('裸路径 / 非 <root>:/ 形态 → false', () => {
    expect(isStorageUri('/abs/path')).toBe(false);
    expect(isStorageUri('relative/path.txt')).toBe(false);
    expect(isStorageUri('data:image/png')).toBe(false); // 无 :/ 也无 base64
    expect(isStorageUri('justtext')).toBe(false);
    expect(isStorageUri('')).toBe(false);
  });
});

describe('parseUriRoot', () => {
  it('取根名', () => {
    expect(parseUriRoot('data:/images/x.jpg')).toBe('data');
    expect(parseUriRoot('workspace:/a/b')).toBe('workspace');
  });
  it('非法形态抛错', () => {
    expect(() => parseUriRoot('/abs')).toThrow();
    expect(() => parseUriRoot('justtext')).toThrow();
  });
});

describe('toStorageUri（配置路径归一）', () => {
  it('已是 URI → 原样', () => {
    expect(toStorageUri('data:/x')).toBe('data:/x');
    expect(toStorageUri('workspace:/a/b')).toBe('workspace:/a/b');
  });
  it('多段 foo/bar → foo:/bar（首段当根）', () => {
    expect(toStorageUri('data/personas')).toBe('data:/personas');
    expect(toStorageUri('logs/x.log')).toBe('logs:/x.log');
  });
  it('单段裸名 → fallbackRoot:/name（默认 data，不把裸名当根名）', () => {
    expect(toStorageUri('aalis.db')).toBe('data:/aalis.db');
    expect(toStorageUri('lancedb')).toBe('data:/lancedb');
    expect(toStorageUri('foo', 'workspace')).toBe('workspace:/foo');
  });
  it('去前导 ./ 与 /', () => {
    expect(toStorageUri('./data/x')).toBe('data:/x');
    expect(toStorageUri('/data/x')).toBe('data:/x');
  });
});

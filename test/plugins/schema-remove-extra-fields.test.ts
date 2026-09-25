import { describe, expect, it } from 'vitest';
import { removeExtraFields } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// removeExtraFields：按 schema 键集裁未知字段。runtime config-sync 与
// webui PUT 都导入这一份——白名单与嵌套前缀一旦漂移，两边政策会各裁各的。
// ════════════════════════════════════════════════════════════

describe('removeExtraFields', () => {
  it('顶层未知键裁掉并记入 removed；schema 内的键原样保留', () => {
    const removed: string[] = [];
    const out = removeExtraFields({ known: 1, junk: 'x' }, { known: { type: 'number', label: 'K' } }, removed);
    expect(out).toEqual({ known: 1 });
    expect(removed).toEqual(['junk']);
  });

  it('嵌套 SchemaGroup：子键裁掉且 removed 带点号前缀', () => {
    const removed: string[] = [];
    const schema = {
      g: { label: 'G', fields: { in: { type: 'number', label: 'I' } } },
    };
    const out = removeExtraFields({ g: { in: 2, deepJunk: 'y' }, keep: 1 }, schema, removed);
    expect(out).toEqual({ g: { in: 2 } });
    expect(removed.sort()).toEqual(['g.deepJunk', 'keep']);
  });

  it('map 字段的值整体保留，不按键裁剪', () => {
    const removed: string[] = [];
    const out = removeExtraFields({ env: { TOKEN: 'x', OTHER: 'y' } }, { env: { type: 'map', label: 'E' } }, removed);
    expect(out).toEqual({ env: { TOKEN: 'x', OTHER: 'y' } });
    expect(removed).toEqual([]);
  });

  it('type 为 array 的值整段保留，不拆元素', () => {
    const removed: string[] = [];
    const schema = { hosts: { type: 'array', label: 'H', items: { k: { type: 'string', label: 'K' } } } };
    const hosts = [{ k: 'a', extra: 1 }];
    const out = removeExtraFields({ hosts }, schema, removed);
    expect(out.hosts).toBe(hosts);
    expect(removed).toEqual([]);
  });
});

declare module '@aalis/api-contributions' {
  interface ContributionPointMap {
    '__t:lifecycle-point': { id: string; label: string };
  }
}

import { describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { Registry } from '../../packages/plugin-contributions/src/index.js';
import { createActivationFixture } from '../helpers/activation.js';

// ════════════════════════════════════════════════════════════
// 贡献点 '__t:lifecycle-point' 经真实的 declaration merging 登记进 @aalis/api-contributions 的 ContributionPointMap：
// contribute / collect 不需要 as never，spec 的字段类型随键推导。门面与登记表的其余行为在 plugin-contributions.test.ts，
// 撤回时机与关闭后登记的政策在 test/core 用测试枢纽锚定。
// ════════════════════════════════════════════════════════════

describe('contributions 门面：经 declaration merging 登记的贡献点', () => {
  it('登记与退订对称；全局键与局部 id 往返不失真（id 含空格等字符）', async () => {
    const root = createActivationFixture();
    root.caps.provide.use(contributions, new Registry());
    const p = root.host.create('p');
    const bound = root.host.bind(p, { contributions }).contributions.use;
    const off = bound.contribute('__t:lifecycle-point', { id: 'a b', label: 'x' });
    expect(bound.collect('__t:lifecycle-point').map(entry => [entry.key, entry.spec.id])).toEqual([['p/a b', 'a b']]);
    off();
    expect(bound.collect('__t:lifecycle-point')).toEqual([]);
    await p.disposeAsync();
  });
});

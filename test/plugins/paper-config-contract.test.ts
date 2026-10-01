import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../packages/core/src/index.js';
import { configSchema, paperAuditSchema, readConfig } from '../../packages/plugin-paper/src/config.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';

function read(raw: Record<string, unknown>) {
  const warn = vi.fn();
  const logger = { warn } as unknown as Logger;
  return {
    cfg: readConfig(parseConfig(configSchema, raw, logger), logger, parseConfig(paperAuditSchema, raw).papers),
    warn,
  };
}

describe('paper 配置契约', () => {
  it('每纸日额度缺省不额外限制，具名纸不继承默认日额度，可单独设限或设零禁用', () => {
    expect(read({}).cfg.defaults.dailyCents).toBeUndefined();
    const { cfg } = read({
      defaults: { dailyCents: 5000 },
      papers: [{ name: 'inherit' }, { name: 'small', dailyCents: 1000 }, { name: 'closed', dailyCents: 0 }],
    });
    expect(cfg.defaults.dailyCents).toBe(5000);
    expect(cfg.papers.get('inherit')?.dailyCents).toBeUndefined();
    expect(cfg.papers.get('small')?.dailyCents).toBe(1000);
    expect(cfg.papers.get('closed')?.dailyCents).toBe(0);
  });

  it.each([
    -1,
    0.5,
    'bad',
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('错误的每纸额度 %s 拒绝配置或具名项，不能回退成无限制', value => {
    expect(() => read({ defaults: { dailyCents: value } })).toThrow();
    expect(() => read({ globalDailyCents: value })).toThrow();
    const { cfg, warn } = read({ papers: [{ name: 'wrong', dailyCents: value }] });
    expect(cfg.papers.has('wrong')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('发布目标按纸继承，显式空禁止发布，默认目标必须留在白名单内', () => {
    const { cfg } = read({
      defaults: { publishTargets: 'works, works-east, works', defaultPublishTarget: 'works-east' },
      papers: [
        { name: 'inherit' },
        { name: 'none', publishTargets: '', defaultPublishTarget: '' },
        { name: 'other', publishTargets: 'works-west', defaultPublishTarget: 'works-east' },
      ],
    });
    expect(cfg.defaults.publishTargets).toEqual(['works', 'works-east']);
    expect(cfg.defaults.defaultPublishTarget).toBe('works-east');
    expect(cfg.papers.get('inherit')?.publishTargets).toEqual(['works', 'works-east']);
    expect(cfg.papers.get('none')?.publishTargets).toEqual([]);
    expect(cfg.papers.get('none')?.defaultPublishTarget).toBeUndefined();
    expect(cfg.papers.get('other')?.publishTargets).toEqual(['works-west']);
    expect(cfg.papers.get('other')?.defaultPublishTarget).toBeUndefined();
  });

  it.each([
    ['defaults.publishTargets 写成数组', { defaults: { publishTargets: ['blog'] } }],
    ['defaults.publishTargets 写成空数组', { defaults: { publishTargets: [] } }],
    ['defaults.remoteAgentEgress 写错', { defaults: { remoteAgentEgress: 'closed' } }],
    ['sendHtml 写成字符串', { sendHtml: 'no' }],
  ])('%s：拒绝配置，不回落到更宽的默认值', (_label, raw) => {
    expect(() => read(raw)).toThrow();
  });

  it('defaults.publishTargets 只写键名不写值按未填写取默认，只有空字符串禁止发布', () => {
    expect(read({ defaults: { publishTargets: null } }).cfg.defaults.publishTargets).toEqual(['works']);
    expect(read({ defaults: { publishTargets: '' } }).cfg.defaults.publishTargets).toEqual([]);
  });

  it('全局金额缺省不限制，零不被当作缺省；预留和时长仍有默认值', () => {
    const { cfg, warn } = read({ reserveDefaultCents: 0, maxRunMinutes: 0.002 });
    expect(cfg.globalDailyCents).toBeUndefined();
    expect(read({ globalDailyCents: null }).cfg.globalDailyCents).toBeUndefined();
    expect(read({ globalDailyCents: 0 }).cfg.globalDailyCents).toBe(0);
    expect(cfg.reserveDefaultCents).toBe(50);
    expect(cfg.maxRunMinutes).toBe(20);
    expect(cfg).not.toHaveProperty('worksCredit');
    expect(warn).toHaveBeenCalled();
  });

  it('具名白纸继承默认属性；无效名字不生效', () => {
    const { cfg } = read({
      globalDailyCents: 1000,
      defaults: { remoteAgentType: '@aalis/remote-a', remoteAgentEgress: 'none', maxWaiting: 2 },
      papers: [
        { name: 'valid', maxPerUser: 0 },
        { name: 'bad/name', remoteAgentEgress: 'open' },
      ],
    });
    expect(cfg.papers.get('valid')).toMatchObject({
      remoteAgentType: '@aalis/remote-a',
      remoteAgentEgress: 'none',
      maxWaiting: 2,
    });
    expect(cfg.papers.get('valid')?.maxPerUser).toBeUndefined();
    expect(cfg.papers.has('bad/name')).toBe(false);
    expect(cfg.papers.size).toBe(1);
  });

  it.each([
    ['出网上限写错', { remoteAgentEgress: 'wide-open' }, '出网上限'],
    ['发布目标含无效 ID', { publishTargets: 'works, Bad Target' }, '发布目标'],
    ['发布目标写成数组（整条被丢）', { publishTargets: ['works'] }, '不合规则'],
    ['日额度写错（整条不合规则）', { dailyCents: -1 }, '不合规则'],
  ])('安全：具名白纸%s时停用，同名的后续条目不能顶替，原因写进 brokenPapers 并告警', (_label, fields, reason) => {
    const { cfg, warn } = read({
      defaults: { remoteAgentEgress: 'none' },
      papers: [
        { name: 'pilot', ...fields },
        { name: 'pilot', remoteAgentEgress: 'open', publishTargets: 'works' },
      ],
    });
    expect(cfg.papers.has('pilot')).toBe(false);
    expect(cfg.brokenPapers.get('pilot')).toContain(reason);
    expect(warn.mock.calls.flat().join('\n')).toContain('pilot');
  });

  it('同名写了多条、其中有写错的：分不出哪条是本意，整块停用', () => {
    const { cfg } = read({ papers: [{ name: 'pilot' }, { name: 'pilot', remoteAgentEgress: 'wide-open' }] });
    expect(cfg.papers.has('pilot')).toBe(false);
    expect(cfg.brokenPapers.get('pilot')).toContain('同名写了多条');
  });

  it('对照：同名写了多条但都写对时，照旧以第一条为准，后面的按重名忽略', () => {
    const { cfg, warn } = read({
      papers: [
        { name: 'pilot', maxWaiting: 2 },
        { name: 'pilot', maxWaiting: 3 },
      ],
    });
    expect(cfg.papers.get('pilot')?.maxWaiting).toBe(2);
    expect(cfg.brokenPapers.size).toBe(0);
    expect(warn.mock.calls.flat().join('\n')).toContain('重名');
  });

  it('安全：默认属性的发布目标含无效 ID 时拒绝启用，不再忽略后照用', () => {
    expect(() => read({ defaults: { publishTargets: 'works, Bad Target' } })).toThrow(/发布目标/);
  });
});

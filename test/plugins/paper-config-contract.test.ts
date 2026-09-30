import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../packages/core/src/index.js';
import { configSchema, readConfig } from '../../packages/plugin-paper/src/config.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';

function read(raw: Record<string, unknown>) {
  const warn = vi.fn();
  const logger = { warn } as unknown as Logger;
  return { cfg: readConfig(parseConfig(configSchema, raw, logger), logger), warn };
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

  it('具名白纸继承默认属性；无效名字和出网上限不放宽能力', () => {
    const { cfg } = read({
      globalDailyCents: 1000,
      defaults: { remoteAgentType: '@aalis/remote-a', remoteAgentEgress: 'none', maxWaiting: 2 },
      papers: [
        { name: 'valid', remoteAgentEgress: 'wide-open', maxPerUser: 0 },
        { name: 'bad/name', remoteAgentEgress: 'open' },
        { name: 'valid', remoteAgentEgress: 'open' },
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
});

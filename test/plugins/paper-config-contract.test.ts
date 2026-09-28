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
  it('无效预算按关闭远端任务处理，低于时长下限回落默认值', () => {
    const { cfg, warn } = read({ globalDailyCents: -1, reserveDefaultCents: 0, maxRunMinutes: 0.002 });
    expect(cfg.globalDailyCents).toBe(0);
    expect(cfg.reserveDefaultCents).toBe(50);
    expect(cfg.maxRunMinutes).toBe(20);
    expect(cfg.worksCredit).toBe('来自群友的点子');
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

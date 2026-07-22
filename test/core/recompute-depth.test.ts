import { describe, expect, it } from 'vitest';
import { App, LogHub } from '../../packages/core/src/index.js';

/**
 * recompute 收敛上限回归（maxRounds = 2N+8，从图规模推导）
 *
 * 拆除级联沿依赖 DAG 每轮只推进一层（Phase A 逆序遍历时，下游插件在本轮
 * 早于其提供者被检查，级联要到下一轮才可见）。因此深度 D 的 required 链
 * 拆除需要 ~D 轮——旧的硬编码 maxRounds=20 会把 D>20 的**合法**级联误判为
 * "疑似循环依赖"并留下部分收敛态。本测试用 24 层链锁死推导式上限的行为：
 * 全链收敛、无未收敛告警。
 */
describe('recompute 深级联收敛（maxRounds 推导式上限）', () => {
  it('24 层 required 链拆除全量收敛为 pending，不触发未收敛告警', async () => {
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry(e => {
      if (e.level === 'warn') warns.push(e.message);
    });
    const app = new App({ config: { name: 'T', logLevel: 'warn', plugins: {} }, logHub: hub });

    const DEPTH = 24; // > 旧硬编码上限 20
    await app.plugin({
      name: 'root',
      provides: ['svc-0'],
      apply(c) {
        c.provide('svc-0', { level: 0 });
      },
    });
    for (let i = 1; i <= DEPTH; i++) {
      await app.plugin({
        name: `chain-${i}`,
        provides: [`svc-${i}`],
        inject: { required: [`svc-${i - 1}`] },
        apply(c) {
          c.provide(`svc-${i}`, { level: i });
        },
      });
    }

    // 全链已激活
    const before = app.plugins.getStatus();
    expect(before.filter(p => p.state === 'active')).toHaveLength(DEPTH + 1);

    // 拔掉根 → 拆除级联逐层传播 DEPTH 轮
    await app.plugins.unload('root');

    const after = app.plugins.getStatus();
    const chain = after.filter(p => p.name.startsWith('chain-'));
    expect(chain).toHaveLength(DEPTH);
    // 全部收敛为 pending（部分收敛=有插件仍 active，即旧上限的误判症状）
    expect(chain.filter(p => p.state === 'pending')).toHaveLength(DEPTH);
    // 未触发"未收敛"告警
    expect(warns.filter(w => w.includes('未收敛'))).toHaveLength(0);

    await app.stop();
  });
});

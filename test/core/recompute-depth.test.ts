import { describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, LogHub, provide } from '../../packages/core/src/index.js';

/**
 * recompute 收敛上限回归（maxRounds = 2N+8，从图规模推导）
 *
 * 拆除级联沿依赖 DAG 每轮只推进一层（Phase A 逆序遍历时，下游插件在本轮
 * 早于其提供者被检查，级联要到下一轮才可见）。因此深度 D 的 required 链
 * 拆除需要 ~D 轮——硬编码小上限会把合法深链误判为振荡并留下部分收敛态。
 * 本测试用 24 层链锁死推导式上限：全链收敛、无未收敛告警。
 */
describe('recompute 深级联收敛（maxRounds 推导式上限）', () => {
  it('24 层 required 链拆除全量收敛为 pending，不触发未收敛告警', async () => {
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry(e => {
      if (e.level === 'warn') warns.push(e.message);
    });
    const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });

    const DEPTH = 24; // 2N+8 必须盖住这条链；固定小数上限会把合法深链误判为振荡
    const descs = Array.from({ length: DEPTH + 1 }, (_, i) => defineService<{ level: number }>(`rd-svc-${i}`));

    await app.plugin(
      definePlugin({
        name: 'root',
        provides: [descs[0]],
        uses: { provide },
        apply({ provide }) {
          provide(descs[0], { level: 0 });
        },
      }),
    );
    for (let i = 1; i <= DEPTH; i++) {
      const prev = descs[i - 1];
      const cur = descs[i];
      await app.plugin(
        definePlugin({
          name: `chain-${i}`,
          provides: [cur],
          uses: { provide, prev },
          apply({ provide }) {
            provide(cur, { level: i });
          },
        }),
      );
    }

    await app.plugins.idle();
    const before = app.plugins.getStatus();
    expect(before.filter(p => p.state === 'active')).toHaveLength(DEPTH + 1);

    // 拔掉根 → 拆除级联逐层传播 DEPTH 轮。unload 在已有 flight 在飞时排队
    // 早退（单飞契约），断言前先等状态机静置。
    await app.plugins.unload('root');
    await app.plugins.idle();

    const after = app.plugins.getStatus();
    const chain = after.filter(p => p.name.startsWith('chain-'));
    expect(chain).toHaveLength(DEPTH);
    expect(chain.filter(p => p.state === 'pending')).toHaveLength(DEPTH);
    expect(warns.filter(w => w.includes('未收敛'))).toHaveLength(0);

    await app.stop();
  });
});

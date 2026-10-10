import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, definePlugin, defineService, lifecycle, optional, provide } from '../../packages/core/src/index.js';
import { ACTIONS, createWorld, type Profile, TIMEOUT, type Violation } from '../helpers/interleave.js';

// ════════════════════════════════════════════════════════════
// 管理动作、服务撤回、偏好（全局与按插件）切换与停机的随机交错（带种子，全程假时钟）。不变量：
// I1 同一 id 至多一个未落定的实例；I2 stop 之后不再开始 apply；I3 stop、idle 与管理调用在时限内落定；
// I4 停机后没有 active / activating；I5 sticky 事件每个监听器至多一次；I6 收尾时 required 依赖仍有提供者
// （依赖本身被撤下的除外）；I7 停机完成前跑过 apply 的实例都执行过 onDispose；I8 stop 之后管理动作返回 false；
// I9 同一个跟随者的清理落定之前不重挂。
// 两档见 Profile：strict 的清理都在宽限内、没有非管理撤回；overrun-withdraw 两者都允许。任何违例都让用例失败，
// 列出种子与详情。加大种子数：AALIS_FUZZ_SEEDS=2000；复现单个种子并打印全程记录：AALIS_FUZZ_SEED=38。
// ════════════════════════════════════════════════════════════

const ONE = Number(process.env.AALIS_FUZZ_SEED);
const SEEDS = Number(process.env.AALIS_FUZZ_SEEDS) || 150;
const seeds = ONE ? [ONE] : Array.from({ length: SEEDS }, (_, k) => k + 1);
const BOUND = 250 * TIMEOUT;

async function runWorld(seed: number, profile: Profile): Promise<Violation[]> {
  const w = createWorld(seed, profile);
  const { r } = w;
  const extra = profile === 'strict' ? [] : (['withdraw', 'withdraw', 'reprovide'] as const);
  const ops = [...ACTIONS, 'bounce', 'prefer', ...extra] as const;
  const steps = 60 + r.int(40);
  const stopAt = (steps >> 1) + r.int(steps >> 1);
  const idleAt = r.int(stopAt);
  const waits: Array<{ what: string; since: number; done?: number }> = [];
  const watch = (what: string, promise: Promise<unknown>) => {
    const wait: (typeof waits)[number] = { what, since: Date.now() };
    waits.push(wait);
    void promise.then(() => {
      wait.done = Date.now();
    });
  };
  watch('pluginAll', w.app.pluginAll(w.defs.map(definition => ({ definition, disabled: r.chance(0.1) }))));
  watch('start', w.app.start());
  for (let step = 0; step < steps; step++) {
    if (step === idleAt) watch('idle', w.app.plugins.idle());
    if (step === stopAt) watch('stop', w.stop());
    const op = r.pick(ops);
    const i = r.int(w.n);
    if (op === 'prefer' || op === 'withdraw' || op === 'reprovide') w[op](i);
    else w.manage(w.app.plugins, op, i, r.int(9));
    await vi.advanceTimersByTimeAsync(r.int(31));
  }
  for (let t = 0; t < BOUND && (w.inflight() > 0 || waits.some(x => x.done === undefined)); t += 20)
    await vi.advanceTimersByTimeAsync(20);
  for (const x of waits) if (x.done === undefined || x.done - x.since > BOUND) w.flag('I3', `${x.what} 未在时限内落定`);
  if (w.inflight() > 0) w.flag('I3', `${w.inflight()} 个管理调用未落定`);
  for (const s of w.app.plugins.getStatus())
    if (s.state === 'active' || s.state === 'activating') w.flag('I4', `${s.instanceId} 停机后仍 ${s.state}`);
  for (const inst of w.instances) if (!inst.disposeCalled) w.flag('I7', `${inst.id}#${inst.gen} 没有执行 onDispose`);
  if (ONE) console.info(w.trace.join('\n'));
  return w.violations;
}

async function sweep(profile: Profile) {
  const found: Array<Violation & { seed: number }> = [];
  for (const seed of seeds) for (const v of await runWorld(seed, profile)) found.push({ seed, ...v });
  return found;
}

describe('插件管理随机交错', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it.each(['strict', 'overrun-withdraw'] as const)(
    '%s：不变量全部成立',
    async profile => {
      expect(await sweep(profile)).toEqual([]);
    },
    120_000 + seeds.length * 1000,
  );
});

// X16：消费者经 optional 依赖从 list() 现选非胜者。非胜者重启后排在消费者之后激活，停机按自然次序会先关它；
// 关停边覆盖已声明服务的全部提供者，消费者收尾时它仍在。
it('X16：停机时消费者现选的非胜者不会先于消费者收尾', async () => {
  const svc = defineService<object>('zz-fz-x16');
  const provider = definePlugin({
    name: 'zz-x16-prov',
    reusable: true,
    provides: [svc],
    uses: { provide },
    apply: ({ provide }) => void provide.use(svc, {}),
  });
  let seen: boolean | undefined;
  const consumer = definePlugin({
    name: 'zz-x16-cons',
    uses: { svc: optional(svc), lifecycle },
    apply({ svc, lifecycle }) {
      lifecycle.use.onDrain(() => {
        seen = svc.list().some(p => p.id === 'zz-x16-prov:b');
      });
    },
  });
  const app = new App({ name: 'x16', logLevel: 'error' });
  await app.pluginAll([
    { definition: provider, instanceId: 'zz-x16-prov:a' },
    { definition: provider, instanceId: 'zz-x16-prov:b' },
    { definition: consumer },
  ]);
  await app.plugins.idle();
  await app.plugins.bounce('zz-x16-prov:b');
  await app.plugins.idle();
  await app.stop();
  expect(seen).toBe(true);
});

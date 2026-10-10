import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, definePlugin, defineService, lifecycle, optional, provide } from '../../packages/core/src/index.js';
import { ACTIONS, createWorld, type Profile, TIMEOUT, type Violation } from '../helpers/interleave.js';

// ════════════════════════════════════════════════════════════
// 管理动作、服务撤回、偏好切换与停机的随机交错（带种子，全程假时钟）。不变量：
// I1 同一 id 至多一个未落定的实例；I2 stop 之后不再开始 apply；I3 stop、idle 与管理调用在时限内落定；
// I4 停机后没有 active / activating；I5 sticky 事件每个监听器至多一次；I6 收尾时 required 依赖仍有提供者
// （依赖本身被撤下的除外）；I7 停机完成前跑过 apply 的实例都执行过 onDispose；I8 stop 之后管理动作返回 false。
// strict 的清理都在宽限内、没有非管理撤回；known-gaps 两者都允许。违例按成因归类，未归类的必须为 0；
// 已知缺口各用一个固定种子的 it.fails 钉住，修好后改回 it 并从 KNOWN 去掉。
// 加大种子数：AALIS_FUZZ_SEEDS=500；复现单个种子并打印全程记录：AALIS_FUZZ_SEED=38。
// ════════════════════════════════════════════════════════════

const ONE = Number(process.env.AALIS_FUZZ_SEED);
const SEEDS = Number(process.env.AALIS_FUZZ_SEEDS) || 32;
const seeds = ONE ? [ONE] : Array.from({ length: SEEDS }, (_, k) => k + 1);
const BOUND = 250 * TIMEOUT;
const KNOWN: Record<Profile, Violation['cause'][]> = { strict: ['overlap'], 'known-gaps': ['S2', 'S3', 'overlap'] };

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
  for (const x of waits)
    if (x.done === undefined || x.done - x.since > BOUND) w.flag('I3', 'unclassified', `${x.what} 未在时限内落定`);
  if (w.inflight() > 0) w.flag('I3', 'unclassified', `${w.inflight()} 个管理调用未落定`);
  for (const s of w.app.plugins.getStatus())
    if (s.state === 'active' || s.state === 'activating')
      w.flag('I4', 'unclassified', `${s.instanceId} 停机后仍 ${s.state}`);
  for (const inst of w.instances)
    if (!inst.disposeCalled) w.flag('I7', 'unclassified', `${inst.id}#${inst.gen} 没有执行 onDispose`);
  if (ONE) console.info(w.trace.join('\n'));
  return w.violations;
}

async function sweep(profile: Profile) {
  const found: Array<Violation & { seed: number }> = [];
  for (const seed of seeds) for (const v of await runWorld(seed, profile)) found.push({ seed, ...v });
  const counts = KNOWN[profile].map(cause => `${cause} ${found.filter(v => v.cause === cause).length}`);
  console.info(`${profile} ${seeds.length} 个种子：${counts.join('，')}`);
  return found.filter(v => !KNOWN[profile].includes(v.cause));
}

describe('插件管理随机交错', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('strict：不变量全部成立', { timeout: 120_000 + seeds.length * 1000 }, async () => {
    expect(await sweep('strict')).toEqual([]);
  });

  it('known-gaps：违例都能归到已知缺口', { timeout: 120_000 + seeds.length * 1000 }, async () => {
    expect(await sweep('known-gaps')).toEqual([]);
  });

  const pin = (cause: Violation['cause'], seed: number, profile: Profile) => async () => {
    expect((await runWorld(seed, profile)).filter(v => v.cause === cause)).toEqual([]);
  };
  it.fails('S2 未修：清理超时后同一 id 新旧实例并存（known-gaps seed=2）', pin('S2', 2, 'known-gaps'));
  it.fails('S3 未修：连锁退场时下游收尾失去上游（known-gaps seed=11）', pin('S3', 11, 'known-gaps'));
  it.fails('overlap 未修：后一份管理计划不等前一份里还没收尾的消费者（strict seed=38）', pin('overlap', 38, 'strict'));
});

// X16：消费者经 optional 依赖按 contextId 从 all() 现选非胜者。关停边只连胜者；非胜者重启后排在消费者之后激活，
// 停机按自然次序先关它，消费者收尾时已找不到它。关停边覆盖已声明服务的全部提供者后改回 it。
it.fails('X16 未修：停机时消费者现选的非胜者不会先于消费者收尾', async () => {
  const svc = defineService<object>('zz-fz-x16');
  const provider = definePlugin({
    name: 'zz-x16-prov',
    reusable: true,
    provides: [svc],
    uses: { provide },
    apply: ({ provide }) => void provide(svc, {}),
  });
  let seen: boolean | undefined;
  const consumer = definePlugin({
    name: 'zz-x16-cons',
    uses: { svc: optional(svc), lifecycle },
    apply({ svc, lifecycle }) {
      lifecycle.onDrain(() => {
        seen = svc.all().some(v => v.contextId === 'zz-x16-prov:b');
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

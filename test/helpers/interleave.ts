import {
  App,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  optional,
  type PluginManagerService,
  pluginsService,
  provide,
  type ServiceRef,
  services,
  type Uses,
} from '../../packages/core/src/index.js';

/** 带种子的伪随机数（mulberry32）：同一种子同一序列 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由主种子与序号派生子流种子 */
function hash(seed: number, i: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  return (h ^ (h >>> 15)) >>> 0;
}

function stream(seed: number) {
  const next = mulberry32(seed);
  return {
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

export type Profile = 'strict' | 'known-gaps';
/** S2：清理超时后新旧实例并存；S3：连锁退场时下游收尾失去上游；overlap：两份管理关闭计划重叠，后一份不等前一份里还没收尾的消费者 */
export interface Violation {
  inv: string;
  cause: 'S2' | 'S3' | 'overlap' | 'unclassified';
  detail: string;
}
export const ACTIONS = ['register', 'unload', 'enable', 'disable', 'bounce', 'updateConfig'] as const;
export const TIMEOUT = 40;
type Timing = 'sync' | 'short' | 'over' | 'never';
type Impl = { id: string };

class Instance {
  /** 尚未落定的 apply / onDrain / onDispose */
  pending = 0;
  disposeCalled = false;
  draining = false;
  /** 拆卸方对它的某次等待已超时放弃 */
  abandoned = false;
  /** 它被另一份关闭计划带走、尚未收尾时，它的 required 提供者先收尾了 */
  overtaken = false;
  off?: () => void;
  constructor(
    readonly id: string,
    readonly gen: number,
    readonly needs: string[],
    readonly give: () => void,
  ) {}
  /** 从 apply 开始，到 onDispose 执行过且在途回调都落定 */
  get live(): boolean {
    return !this.disposeCalled || this.pending > 0;
  }
}

/** 随机插件世界：required 依赖只指向序号更小的提供者（无静态环），optional 依赖任意 */
export function createWorld(seed: number, profile: Profile) {
  const r = stream(seed);
  const gaps = profile === 'known-gaps';
  const violations: Violation[] = [];
  const trace: string[] = [];
  const t0 = Date.now();
  const note = (line: string) => void trace.push(`${Date.now() - t0} ${line}`);
  const instances: Instance[] = [];
  const latest = new Map<string, Instance>();
  /** 服务此刻无人提供的原因：提供者撤下（手动撤回、转入后台），或提供者因丢依赖连锁退场 */
  const tags = new Map<string, 'loss' | 'cascade'>();
  let stopped = false;
  let inflight = 0;
  const flag = (inv: string, cause: Violation['cause'], detail: string) => void violations.push({ inv, cause, detail });
  const running = (id: string) => ['active', 'activating'].includes(app.plugins.getPlugin(id)?.state ?? '');
  /** 还没收尾，也不再是注册表里在跑的那个实例：已被某份关闭计划带走 */
  const waiting = (o: Instance) => !o.disposeCalled && !o.draining && !(latest.get(o.id) === o && running(o.id));

  const capture = (scope: string): Logger => {
    const warn = (message: string, ...args: unknown[]) => {
      const text = [message, ...args].map(String).join(' ');
      note(`${scope}: ${text}`);
      const held = /^插件 "p(\d+)" 激活超过/.exec(text);
      if (held) lose(Number(held[1]));
      if (/放弃等待|未在宽限内停止/.test(text))
        for (const o of instances) if (o.live && (scope === o.id || text.includes(`"${o.id}"`))) o.abandoned = true;
    };
    return { debug() {}, info() {}, warn, error: warn, child: capture };
  };
  const app = new App({ name: 'fuzz', logger: capture('app'), disposeTimeoutMs: TIMEOUT, slowThresholdMs: 60 });
  const host = app.bind({ services, events });
  host.events.on('service:registered', name => {
    if (host.services.get(name) !== undefined) tags.delete(name);
  });

  const n = 6 + r.int(5);
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const group: number[] = [];
  for (let i = 0; i < n; i++) group.push(i > 0 && r.chance(0.35) ? group[i - 1] : i);
  const descs = new Map(group.map(k => [k, defineService<Impl>(`zz-fz-s${k}`)]));
  const ownName = (i: number) => descs.get(group[i])!.name;
  /** 撤下会同栈引发连锁收尾，所以在撤下之前记；剩下的提供者都在退场也算丢失 */
  const lose = (i: number) => {
    if (host.services.all(ownName(i)).every(v => v.contextId === ids[i] || !running(v.contextId)))
      tags.set(ownName(i), 'loss');
  };

  const manage = (pm: PluginManagerService, action: (typeof ACTIONS)[number], i: number, v: number): void => {
    const id = ids[i];
    const after = stopped;
    inflight++;
    note(`${action}(${id})`);
    const call =
      action === 'register'
        ? pm.register(defs[i], { v })
        : action === 'updateConfig'
          ? pm.updateConfig(id, { v })
          : pm[action](id);
    void call.then(ok => {
      inflight--;
      if (after && ok) flag('I8', 'unclassified', `stop 之后 ${action}(${id}) 返回 true`);
    });
  };

  const defs = ids.map((id, i) => {
    const own = descs.get(group[i])!;
    const required = [...descs].filter(([k]) => group.lastIndexOf(k) < i && r.chance(0.3)).map(([, d]) => d);
    const optionals = [...descs].filter(([k, d]) => k !== group[i] && !required.includes(d) && r.chance(0.15));
    const deps: Uses = Object.fromEntries([
      ...required.map(d => [d.name, d]),
      ...optionals.map(([, d]) => [d.name, optional(d)]),
    ]);
    const needs = required.map(d => d.name);
    const priority = r.int(3);
    const pr = stream(hash(seed, i));
    let gen = 0;
    // strict 的清理都在宽限内；apply 可以慢到转入后台，但响应 abort
    const timing = (apply: boolean): Timing => {
      const x = pr.int(20);
      if (x < 8) return 'sync';
      if (x < 16 || (!gaps && !apply)) return 'short';
      return x < 19 || !gaps ? 'over' : 'never';
    };
    const run = (inst: Instance, t: Timing, signal?: AbortSignal): Promise<void> | undefined => {
      if (t === 'sync') return;
      inst.pending++;
      const ms = t === 'short' ? 1 + pr.int(TIMEOUT / 2) : TIMEOUT + 5 + pr.int(2 * TIMEOUT);
      const work = new Promise<void>((resolve, reject) => {
        if (t === 'never') return;
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, ms);
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
      const done = () => void inst.pending--;
      work.then(done, done);
      return work;
    };
    const reenter = (pm: PluginManagerService | undefined) => {
      if (pm && pr.chance(0.08)) manage(pm, pr.pick(ACTIONS), pr.int(n), pr.int(9));
    };
    return definePlugin({
      name: id,
      provides: [own],
      uses: { lifecycle, events, provide, plugins: pluginsService, ...deps },
      apply(caps) {
        const refs = caps as unknown as Record<string, ServiceRef<Impl>>;
        const inst = new Instance(id, ++gen, needs, () => {
          inst.off = caps.provide(own, { id }, { priority });
        });
        const tag = `${id}#${inst.gen}`;
        note(`apply ${tag}`);
        if (stopped) flag('I2', 'unclassified', `${tag} 在 stop 之后开始 apply`);
        const others = instances.filter(o => o.id === id && o.live);
        if (others.length > 0)
          flag('I1', others.every(o => o.abandoned) ? 'S2' : 'unclassified', `${tag} 开始时旧实例仍未落定`);
        instances.push(inst);
        latest.set(id, inst);
        let heard = 0;
        caps.events.on('app:ready', () => {
          if (++heard === 2) flag('I5', 'unclassified', `${tag} 两次收到 app:ready`);
        });
        caps.lifecycle.onDrain(() => {
          note(`drain ${tag}`);
          inst.draining = true;
          for (const o of instances) if (o.needs.includes(own.name) && waiting(o)) o.overtaken = true;
          const lost = needs.filter(name => refs[name].current === undefined);
          for (const name of lost) {
            const why = tags.get(name);
            const cause = why === 'cascade' ? 'S3' : inst.overtaken ? 'overlap' : 'unclassified';
            if (why !== 'loss') flag('I6', cause, `${tag} 收尾时 ${name} 已无提供者`);
          }
          if (lost.length > 0 && !tags.has(own.name)) tags.set(own.name, 'cascade');
          return run(inst, timing(false));
        });
        caps.lifecycle.onDispose(() => {
          note(`dispose ${tag}`);
          inst.disposeCalled = true;
          reenter(caps.plugins.current);
          return run(inst, timing(false));
        });
        for (const name of needs) refs[name].require();
        inst.give();
        reenter(caps.plugins.current);
        return run(inst, timing(true), !gaps || pr.chance(0.5) ? caps.lifecycle.signal : undefined);
      },
    });
  });

  return {
    app,
    r,
    n,
    defs,
    violations,
    instances,
    trace,
    flag,
    manage,
    inflight: () => inflight,
    stop() {
      stopped = true;
      note('stop');
      return app.stop();
    },
    prefer(i: number) {
      if (r.chance(0.3)) host.services.unprefer(ownName(i));
      else host.services.prefer(ownName(i), ids[i]);
    },
    /** 非管理撤回：插件自己撤掉登记，激活不动 */
    withdraw(i: number) {
      const inst = latest.get(ids[i]);
      if (!inst?.off || inst.draining) return;
      note(`withdraw ${ids[i]}`);
      lose(i);
      inst.off();
      inst.off = undefined;
    },
    reprovide(i: number) {
      const inst = latest.get(ids[i]);
      if (inst && !inst.off && !inst.draining) inst.give();
    },
  };
}

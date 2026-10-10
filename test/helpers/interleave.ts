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
  type ServiceSelection,
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

/**
 * strict：清理都在宽限内、apply 都响应 abort、没有非管理撤回；
 * overrun-withdraw：清理可以超过宽限乃至永不落定、apply 可以不理 abort，另有插件自己撤回登记
 */
export type Profile = 'strict' | 'overrun-withdraw';
export interface Violation {
  inv: string;
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
  off?: () => void;
  constructor(
    readonly id: string,
    readonly gen: number,
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
  const overrun = profile === 'overrun-withdraw';
  const violations: Violation[] = [];
  const trace: string[] = [];
  const t0 = Date.now();
  const note = (line: string) => void trace.push(`${Date.now() - t0} ${line}`);
  const instances: Instance[] = [];
  const latest = new Map<string, Instance>();
  /** 提供者撤下（手动撤回、转入后台）而此刻无人提供的服务：依赖它的插件收尾时拿不到它不算违例 */
  const lost = new Set<string>();
  let stopped = false;
  let inflight = 0;
  const flag = (inv: string, detail: string) => void violations.push({ inv, detail });
  const running = (id: string) => ['active', 'activating'].includes(app.plugins.getPlugin(id)?.state ?? '');

  const capture = (scope: string): Logger => {
    const warn = (message: string, ...args: unknown[]) => {
      const text = [message, ...args].map(String).join(' ');
      note(`${scope}: ${text}`);
      const held = /^插件 "p(\d+)" 激活超过/.exec(text);
      if (held) lose(Number(held[1]));
    };
    return { debug() {}, info() {}, warn, error: warn, child: capture };
  };
  const app = new App({ name: 'fuzz', logger: capture('app'), disposeTimeoutMs: TIMEOUT, slowThresholdMs: 60 });
  const host = app.bind({ services, events });
  // 有不在退场的提供者才算找回：撤回自己发的变更通知到达时，退场中的提供者可能还没摘掉
  host.events.use.on('service:changed', name => {
    if (host.services.use.all(name).some(v => running(v.contextId))) lost.delete(name);
  });

  const n = 6 + r.int(5);
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const group: number[] = [];
  for (let i = 0; i < n; i++) group.push(i > 0 && r.chance(0.35) ? group[i - 1] : i);
  const descs = new Map(group.map(k => [k, defineService<Impl>(`zz-fz-s${k}`)]));
  const ownName = (i: number) => descs.get(group[i])!.name;
  /** 撤下会同栈引发连锁收尾，所以在撤下之前记；剩下的提供者都在退场也算丢失 */
  const lose = (i: number) => {
    if (host.services.use.all(ownName(i)).every(v => v.contextId === ids[i] || !running(v.contextId)))
      lost.add(ownName(i));
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
      if (after && ok) flag('I8', `stop 之后 ${action}(${id}) 返回 true`);
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
      if (x < 16 || (!overrun && !apply)) return 'short';
      return x < 19 || !overrun ? 'over' : 'never';
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
        const refs = caps as unknown as Record<string, ServiceSelection<Impl>>;
        const inst = new Instance(id, ++gen, () => {
          inst.off = caps.provide.use(own, { id }, { priority });
        });
        const tag = `${id}#${inst.gen}`;
        note(`apply ${tag}`);
        if (stopped) flag('I2', `${tag} 在 stop 之后开始 apply`);
        if (instances.some(o => o.id === id && o.live)) flag('I1', `${tag} 开始时旧实例仍未落定`);
        instances.push(inst);
        latest.set(id, inst);
        let heard = 0;
        caps.events.use.on('app:ready', () => {
          if (++heard === 2) flag('I5', `${tag} 两次收到 app:ready`);
        });
        caps.lifecycle.use.onDrain(() => {
          note(`drain ${tag}`);
          inst.draining = true;
          for (const name of needs)
            if (!refs[name].present && !lost.has(name)) flag('I6', `${tag} 收尾时 ${name} 已无提供者`);
          return run(inst, timing(false));
        });
        caps.lifecycle.use.onDispose(() => {
          note(`dispose ${tag}`);
          inst.disposeCalled = true;
          reenter(caps.plugins.present ? caps.plugins.use : undefined);
          return run(inst, timing(false));
        });
        for (const name of needs) void refs[name].use.id;
        // 跟随一个 optional 依赖：同一个跟随者的清理落定之前不得重挂
        const watched = optionals[0]?.[1].name;
        if (watched) {
          let attached = 0;
          refs[watched].follow(() => {
            if (++attached > 1) flag('I9', `${tag} 跟随 ${watched}：上一家的清理还没落定就重挂`);
            return () => {
              const done = run(inst, timing(false));
              if (!done) return void attached--;
              return done.then(() => void attached--);
            };
          });
        }
        inst.give();
        reenter(caps.plugins.present ? caps.plugins.use : undefined);
        return run(inst, timing(true), !overrun || pr.chance(0.5) ? caps.lifecycle.use.signal : undefined);
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
    /** 一半是按插件的偏好（随机挑一个消费者） */
    prefer(i: number) {
      const scope = r.chance(0.5) ? { for: ids[r.int(n)] } : undefined;
      if (r.chance(0.3)) host.services.use.unprefer(ownName(i), scope);
      else host.services.use.prefer(ownName(i), ids[i], scope);
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

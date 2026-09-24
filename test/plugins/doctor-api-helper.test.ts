/**
 * api-doctor — `doctor` 描述符的绑定门面
 *
 * 领域插件贡献自我诊断时无需关心 doctor 是否上线，也无需自己记账解注册：
 * 这两条保障现在落在绑定门面上，本文件钉住它的四类行为。
 *
 *  1. **提供者在场**：登记立即生效，退订立即解注册
 *  2. **登记者身份**：未显式写 pluginName 时自动落上这次激活的身份
 *  3. **提供者后到 / 换人**：先登记的挂在账上，doctor 上线后补登记；换提供者整批重挂
 *  4. **随激活存亡**：插件卸载即摘除自己登记的全部检查项，别的登记者不受牵连
 *
 * 驱动面全部走公开入口：最小 definePlugin 探针插件经 app.plugin 装载，
 * doctor 由桩提供者插件提供（可控上线时机与优先级）。
 */
import { App, definePlugin, optional, provide } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BoundDoctor,
  type CheckResult,
  type CheckSpec,
  type DoctorService,
  doctor,
} from '../../packages/api-doctor/src/index.js';

// ===== 桩 DoctorService =====

function makeDoctor(): { svc: DoctorService; specs: Map<string, CheckSpec> } {
  const specs = new Map<string, CheckSpec>();
  const svc: DoctorService = {
    registerCheck(spec) {
      specs.set(spec.id, spec);
      return () => {
        if (specs.get(spec.id) === spec) specs.delete(spec.id);
      };
    },
    listChecks() {
      return [...specs.values()].map(s => ({ id: s.id, category: s.category, pluginName: s.pluginName }));
    },
    async runChecks() {
      const checks: CheckResult[] = [];
      for (const s of specs.values()) {
        const r = await s.run();
        if (Array.isArray(r)) checks.push(...r);
        else checks.push(r);
      }
      return {
        generatedAt: new Date().toISOString(),
        summary: checks.reduce(
          (acc, c) => {
            acc[c.level]++;
            return acc;
          },
          { ok: 0, warn: 0, error: 0 } as { ok: number; warn: number; error: number },
        ),
        checks,
      };
    },
    getLastReport() {
      return undefined;
    },
  };
  return { svc, specs };
}

// ===== 探针与桩提供者 =====

/** 桩 doctor 提供者：装载时机由用例控制，priority 用来制造「换人」 */
function doctorProvider(name: string, svc: DoctorService, priority?: number) {
  return definePlugin({
    name,
    provides: [doctor],
    uses: { provide },
    apply(caps) {
      caps.provide(doctor, svc, priority === undefined ? undefined : { priority });
    },
  });
}

/**
 * 最小消费者插件：把这次激活绑定到的 doctor 门面交出来，用例即以「这个插件的身份」登记检查项。
 * doctor 声明为 optional，探针在 doctor 缺席时也照常激活——「提供者后到」正是要测的场景。
 */
async function loadProbe(app: App, name: string): Promise<BoundDoctor> {
  let bound: BoundDoctor | undefined;
  await app.plugin(
    definePlugin({
      name,
      uses: { doctor: optional(doctor) },
      apply(caps) {
        bound = caps.doctor;
      },
    }),
  );
  await app.plugins.idle();
  if (app.plugins.getPlugin(name)?.state !== 'active') throw new Error(`探针 "${name}" 未激活`);
  if (!bound) throw new Error(`探针 "${name}" 未交出 doctor 门面`);
  return bound;
}

const spec = (id: string, extra?: Partial<CheckSpec>): CheckSpec => ({
  id,
  category: 'env',
  run: () => ({ id, category: 'env', level: 'ok', message: 'ok' }),
  ...extra,
});

let app: App;

beforeEach(() => {
  app = new App({ name: 'T', logLevel: 'error' });
});

afterEach(async () => {
  await app.stop();
});

// ===== tests =====

describe('doctor 门面 — 提供者在场', () => {
  it('doctor 已就绪时立即 registerCheck，退订立即解注册', async () => {
    const { svc, specs } = makeDoctor();
    await app.plugin(doctorProvider('test-doctor', svc));
    const d = await loadProbe(app, 'probe-eager');

    const off = d.registerCheck(spec('eager.x'));

    expect(specs.has('eager.x')).toBe(true);
    off();
    expect(specs.has('eager.x')).toBe(false);
  });

  it('未传 pluginName 时使用登记者（这次激活）的身份', async () => {
    const { svc, specs } = makeDoctor();
    await app.plugin(doctorProvider('test-doctor', svc));
    const d = await loadProbe(app, 'plugin-foo');

    d.registerCheck(spec('attr.x'));

    expect(specs.get('attr.x')?.pluginName).toBe('plugin-foo');
  });

  it('显式传入 pluginName 时优先于登记者身份', async () => {
    const { svc, specs } = makeDoctor();
    await app.plugin(doctorProvider('test-doctor', svc));
    const d = await loadProbe(app, 'plugin-foo');

    d.registerCheck(spec('attr.y', { pluginName: 'explicit-name' }));

    expect(specs.get('attr.y')?.pluginName).toBe('explicit-name');
  });
});

describe('doctor 门面 — 提供者后到与换人', () => {
  it('doctor 未就绪时挂在账上；提供者上线后真正 registerCheck', async () => {
    const d = await loadProbe(app, 'probe-deferred');
    expect(d.current, 'doctor 尚未上线').toBeUndefined();

    const off = d.registerCheck(spec('deferred.a'));
    const { svc, specs } = makeDoctor();
    expect(specs.has('deferred.a'), '提供者还没来，不该有登记落到任何 doctor 上').toBe(false);

    await app.plugin(doctorProvider('test-doctor', svc));
    await app.plugins.idle();
    expect(specs.has('deferred.a'), '提供者上线应补登记挂在账上的检查项').toBe(true);

    off();
    expect(specs.has('deferred.a')).toBe(false);
  });

  it('doctor 上线前退订：提供者后到时不再登记', async () => {
    const d = await loadProbe(app, 'probe-deferred');

    const off = d.registerCheck(spec('deferred.b'));
    off();

    const { svc, specs } = makeDoctor();
    await app.plugin(doctorProvider('test-doctor', svc));
    await app.plugins.idle();
    expect(specs.has('deferred.b'), '已退订的条目不该随提供者上线复活').toBe(false);
  });

  it('多条登记各自独立挂账、独立退订', async () => {
    const d = await loadProbe(app, 'probe-multi');

    const d1 = d.registerCheck(spec('multi.1'));
    const d2 = d.registerCheck(spec('multi.2'));
    d1();

    const { svc, specs } = makeDoctor();
    await app.plugin(doctorProvider('test-doctor', svc));
    await app.plugins.idle();
    expect(specs.has('multi.1'), '上线前已退订的那条不该登记').toBe(false);
    expect(specs.has('multi.2'), '另一条不受牵连').toBe(true);

    d2();
    expect(specs.has('multi.2')).toBe(false);
  });

  it('提供者换人：已登记的检查项整批从旧 doctor 摘除、重挂到新 doctor', async () => {
    const first = makeDoctor();
    const second = makeDoctor();
    await app.plugin(doctorProvider('test-doctor-a', first.svc));
    const d = await loadProbe(app, 'probe-swap');
    d.registerCheck(spec('swap.x'));
    expect(first.specs.has('swap.x')).toBe(true);

    // 高优先级提供者上线即成胜者
    await app.plugin(doctorProvider('test-doctor-b', second.svc, 10));
    await app.plugins.idle();

    expect(second.specs.has('swap.x'), '换人后检查项应重挂到新胜者').toBe(true);
    expect(first.specs.has('swap.x'), '旧提供者上的登记应已撤回').toBe(false);
  });
});

describe('doctor 门面 — 随激活存亡', () => {
  it('登记者卸载：检查项随之摘除，无需插件自己记账', async () => {
    const { svc, specs } = makeDoctor();
    await app.plugin(doctorProvider('test-doctor', svc));
    const d = await loadProbe(app, 'probe-teardown');
    d.registerCheck(spec('teardown.x'));
    expect(specs.has('teardown.x')).toBe(true);

    await app.plugins.unload('probe-teardown');
    expect(specs.has('teardown.x'), '卸载应摘除这次激活登记的全部检查项').toBe(false);
  });

  it('跨插件隔离：卸载一个登记者不影响另一个的检查项', async () => {
    const { svc, specs } = makeDoctor();
    await app.plugin(doctorProvider('test-doctor', svc));
    const a = await loadProbe(app, 'probe-a');
    const b = await loadProbe(app, 'probe-b');
    a.registerCheck(spec('iso.a'));
    b.registerCheck(spec('iso.b'));

    await app.plugins.unload('probe-a');

    expect(specs.has('iso.a')).toBe(false);
    expect(specs.get('iso.b')?.pluginName, '另一个登记者的检查项原样留着').toBe('probe-b');
  });
});

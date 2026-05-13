/**
 * plugin-doctor-api — useDoctorService helper 单元测试
 *
 * 验证两条关键路径：
 *  1. **eager**：doctor 服务已就绪时直接 registerCheck，dispose 立即解注册
 *  2. **deferred**：doctor 未就绪时通过 ctx.whenService 延后；
 *     - doctor 后到时才真正注册
 *     - 在 doctor 到来 *之前* 调 dispose，应取消挂起订阅，doctor 后到时不应再注册
 *     - 在 doctor 到来 *之后* 调 dispose，应解注册已落地的 check
 *
 * 这层 helper 是「领域插件无需关心 doctor 是否上线」的唯一保障，回归很关键。
 */
import type { Context } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { CheckResult, CheckSpec, DoctorService } from '../../packages/plugin-doctor-api/src/index.js';
import { useDoctorService } from '../../packages/plugin-doctor-api/src/index.js';

// ===== Mock DoctorService =====

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
        const r = await s.run({} as Context);
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

// ===== Mock Context =====

interface MockCtx {
  ctx: Context;
  /** 模拟 doctor 服务上线；在此之前 getService('doctor') 返回 undefined */
  bringDoctorOnline(svc: DoctorService): void;
  /** 当前订阅的 whenService 回调数（==1 表示有一个挂起订阅） */
  whenSubscriptionCount(): number;
}

function makeCtx(id = 'test-plugin'): MockCtx {
  const provideMap = new Map<string, unknown>();
  // pendingWhenCallbacks: 等待 doctor 上线时调度的 (cb, cleanupSlot)
  const pending: Array<{ cb: (svc: unknown) => undefined | (() => void); cleanup?: () => void }> = [];

  const ctx = {
    id,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child() {
        return this;
      },
    },
    getService<T>(name: string): T | undefined {
      return provideMap.get(name) as T | undefined;
    },
    whenService<T>(name: string, cb: (svc: T) => undefined | (() => void)): () => void {
      // 已就绪：立即触发
      const ready = provideMap.get(name);
      if (ready !== undefined) {
        const cleanup = cb(ready as T);
        return () => cleanup?.();
      }
      // 未就绪：登记到 pending
      const slot: { cb: (svc: unknown) => undefined | (() => void); cleanup?: () => void } = {
        cb: cb as (svc: unknown) => undefined | (() => void),
      };
      pending.push(slot);
      return () => {
        // 取消挂起订阅；若已触发则调 cleanup
        const idx = pending.indexOf(slot);
        if (idx >= 0) pending.splice(idx, 1);
        slot.cleanup?.();
      };
    },
  } as unknown as Context;

  return {
    ctx,
    bringDoctorOnline(svc: DoctorService) {
      provideMap.set('doctor', svc);
      // 触发所有挂起订阅
      for (const slot of [...pending]) {
        slot.cleanup = slot.cb(svc) ?? undefined;
      }
      pending.length = 0;
    },
    whenSubscriptionCount() {
      return pending.length;
    },
  };
}

// ===== tests =====

describe('useDoctorService — eager 路径', () => {
  it('doctor 已就绪时立即 registerCheck，dispose 立即解注册', () => {
    const { svc, specs } = makeDoctor();
    const m = makeCtx();
    m.bringDoctorOnline(svc);

    const dispose = useDoctorService(m.ctx).registerCheck({
      id: 'eager.x',
      category: 'env',
      run: () => ({ id: 'eager.x', category: 'env', level: 'ok', message: 'ok' }),
    });

    expect(specs.has('eager.x')).toBe(true);
    dispose();
    expect(specs.has('eager.x')).toBe(false);
  });

  it('未传 pluginName 时使用 ctx.id 作为来源', () => {
    const { svc, specs } = makeDoctor();
    const m = makeCtx('plugin-foo');
    m.bringDoctorOnline(svc);

    useDoctorService(m.ctx).registerCheck({
      id: 'attr.x',
      category: 'env',
      run: () => ({ id: 'attr.x', category: 'env', level: 'ok', message: 'ok' }),
    });

    expect(specs.get('attr.x')?.pluginName).toBe('plugin-foo');
  });

  it('显式传入 pluginName 时优先于 ctx.id', () => {
    const { svc, specs } = makeDoctor();
    const m = makeCtx('plugin-foo');
    m.bringDoctorOnline(svc);

    useDoctorService(m.ctx).registerCheck({
      id: 'attr.y',
      category: 'env',
      pluginName: 'explicit-name',
      run: () => ({ id: 'attr.y', category: 'env', level: 'ok', message: 'ok' }),
    });

    expect(specs.get('attr.y')?.pluginName).toBe('explicit-name');
  });
});

describe('useDoctorService — deferred 路径', () => {
  it('doctor 未就绪时挂起；doctor 上线后真正 registerCheck', () => {
    const m = makeCtx();
    const dispose = useDoctorService(m.ctx).registerCheck({
      id: 'deferred.a',
      category: 'env',
      run: () => ({ id: 'deferred.a', category: 'env', level: 'ok', message: 'ok' }),
    });
    expect(m.whenSubscriptionCount()).toBe(1);

    const { svc, specs } = makeDoctor();
    expect(specs.has('deferred.a')).toBe(false);

    m.bringDoctorOnline(svc);
    expect(specs.has('deferred.a')).toBe(true);
    expect(m.whenSubscriptionCount()).toBe(0);

    dispose();
    expect(specs.has('deferred.a')).toBe(false);
  });

  it('doctor 上线前 dispose：取消挂起订阅，doctor 后到时不再注册', () => {
    const m = makeCtx();
    const dispose = useDoctorService(m.ctx).registerCheck({
      id: 'deferred.b',
      category: 'env',
      run: () => ({ id: 'deferred.b', category: 'env', level: 'ok', message: 'ok' }),
    });
    expect(m.whenSubscriptionCount()).toBe(1);

    dispose();
    expect(m.whenSubscriptionCount()).toBe(0);

    const { svc, specs } = makeDoctor();
    m.bringDoctorOnline(svc);
    expect(specs.has('deferred.b')).toBe(false);
  });

  it('多次注册：每条独立挂起，独立 dispose', () => {
    const m = makeCtx();
    const handle = useDoctorService(m.ctx);
    const d1 = handle.registerCheck({
      id: 'multi.1',
      category: 'env',
      run: () => ({ id: 'multi.1', category: 'env', level: 'ok', message: 'ok' }),
    });
    const d2 = handle.registerCheck({
      id: 'multi.2',
      category: 'env',
      run: () => ({ id: 'multi.2', category: 'env', level: 'ok', message: 'ok' }),
    });
    expect(m.whenSubscriptionCount()).toBe(2);

    d1();
    expect(m.whenSubscriptionCount()).toBe(1);

    const { svc, specs } = makeDoctor();
    m.bringDoctorOnline(svc);
    expect(specs.has('multi.1')).toBe(false);
    expect(specs.has('multi.2')).toBe(true);

    d2();
    expect(specs.has('multi.2')).toBe(false);
  });
});

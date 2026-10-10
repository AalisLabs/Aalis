import { afterEach, describe, expect, it } from 'vitest';
import { asr } from '../../packages/api-asr/src/index.js';
import { type CheckResult, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import doctorPlugin from '../../packages/plugin-doctor/src/index.js';
import { createConfigStore, installHostConfig } from '../../packages/runtime/src/config-store.js';

// ════════════════════════════════════════════════════════════
// 诊断「服务偏好未生效」：配置文档里每个服务的偏好，指向的提供者此刻不在这个服务里时报一条警告，写明实际在用哪个
// （没有提供者时写没有）。不只查 llm：哪个服务的偏好悬空都报。偏好都在生效（或没有偏好）时一条通过。
// 宿主配置经 runtime 的 installHostConfig 提供，与启动同序：文档里的偏好先应用到服务容器，再登记插件与提供者。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(servicePreferences: Record<string, string>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  installHostConfig(app, createConfigStore({ servicePreferences }));
  const host = app.bind({ provide, services });
  await app.plugins.register(doctorPlugin, {});
  await app.plugins.idle();
  const run = async (): Promise<CheckResult[]> =>
    (await (host.services.get(doctor) as DoctorService).runChecks()).checks.filter(c =>
      c.id.startsWith('services.preferences'),
    );
  return { host, run };
}

describe('诊断：服务偏好未生效', () => {
  it('偏好指向的提供者不在：每个这样的服务报一条警告，写明实际在用哪个；llm 以外的服务同样报', async () => {
    const { host, run } = await boot({ llm: 'zz-gone/m', asr: 'zz-asr-gone' });
    host.provide(llm, {} as never, { entryId: 'zz-a/m1', label: 'm1' });
    host.provide(llm, {} as never, { entryId: 'zz-b/m2', label: 'm2', priority: 5 });
    host.provide(asr, {} as never, { entryId: 'zz-asr' });

    const results = await run();
    expect(results.map(({ id, category, level, message }) => ({ id, category, level, message }))).toEqual([
      {
        id: 'services.preferences.llm',
        category: 'service',
        level: 'warn',
        message: '服务 llm 的偏好 zz-gone/m 不在提供者里，没有生效',
      },
      {
        id: 'services.preferences.asr',
        category: 'service',
        level: 'warn',
        message: '服务 asr 的偏好 zz-asr-gone 不在提供者里，没有生效',
      },
    ]);
    // 实际在用的是服务此刻解析到的那一个：偏好不在，按优先级
    expect(results[0].detail?.split('\n')[0]).toBe('实际在用：m2（zz-b/m2）');
    expect(results[1].detail?.split('\n')[0]).toBe('实际在用：zz-asr');
    expect(results[0].detail, 'llm 的改法指向「会话默认」的「模型」').toContain('「会话默认」');
    expect(results[0].detail).toContain('servicePreferences.llm');
    expect(results[1].detail).toContain('servicePreferences.asr');
    expect(results[1].detail, '改法不写别的服务的入口').not.toContain('会话默认');
    expect(results[0].detail, '系统页不列 llm 的偏好，指向「会话默认」').not.toContain('「系统」');
  });

  it('偏好指向的服务现在没有提供者：报警并写明没有提供者', async () => {
    const { run } = await boot({ asr: 'zz-asr' });
    const [result] = await run();
    expect(result).toMatchObject({ id: 'services.preferences.asr', level: 'warn' });
    expect(result.detail?.split('\n')[0]).toBe('这个服务现在没有提供者');
  });

  it('偏好都在生效：一条通过', async () => {
    const { host, run } = await boot({ llm: 'zz-a/m1' });
    host.provide(llm, {} as never, { entryId: 'zz-a/m1', label: 'm1' });
    host.provide(llm, {} as never, { entryId: 'zz-b/m2', label: 'm2', priority: 5 });
    expect(await run()).toEqual([
      { id: 'services.preferences', category: 'service', level: 'ok', message: '没有未生效的服务偏好' },
    ]);
  });
});

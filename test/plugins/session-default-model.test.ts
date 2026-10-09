import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import { llm, resolveLLMModel } from '../../packages/api-llm/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { MODEL, PERSONA, startSessionManager } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 默认模型只有一处：llm 服务的偏好。字段类型为 llm-ref 的会话设置项（「模型」）在全局默认层不另存值，按层读写全局默认层时
// 读写的就是偏好（运行态与宿主配置的 servicePreferences.llm），sessionConfig.defaults 不收它。会话的生效配置在全局默认之上
// 各层都没设时不给它的值，取用方交给 resolveLLMModel，落到服务此刻解析到的那一个（偏好指向的模型不在时也有着落）。
// ════════════════════════════════════════════════════════════

const A = '@zz/llm-a';
const B = '@zz/llm-b';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(layers?: AalisConfig['sessionConfig'], save = vi.fn(async (_config: AalisConfig) => {})) {
  const started = await startSessionManager({
    layers,
    settings: [MODEL, PERSONA],
    models: [
      [A, 'm1'],
      [A, 'm2'],
      [B, 'org/m3'],
    ],
    save,
  });
  apps.push(started.app);
  const { services, hostConfig } = started.host;
  return {
    ...started,
    save,
    preferred: () => services.preferred(llm),
    documented: () => hostConfig.require().getServicePreferences().llm,
    sessionConfig: () => hostConfig.require().get('sessionConfig'),
    resolve: (ref: unknown) => resolveLLMModel(started.app.bind({ llm }).llm, ref as never)?.contextId,
  };
}

describe('全局默认层的「模型」就是 llm 服务的偏好', () => {
  it('按层写：运行态与宿主配置的偏好都改并落盘，sessionConfig.defaults 里没有它；按层读到的也是偏好', async () => {
    const { sm, save, preferred, documented, sessionConfig } = await setup();

    await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: A, model: 'm2' }, persona: '<默认人设>' });
    expect(preferred()).toBe(`${A}/m2`);
    expect(documented()).toBe(`${A}/m2`);
    expect(sessionConfig()).toEqual({ defaults: { persona: '<默认人设>' } });
    expect(save).toHaveBeenCalledTimes(1);
    expect(sm.getLayer({ scope: 'defaults' })).toEqual({ persona: '<默认人设>', llm: { provider: A, model: 'm2' } });

    await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: B, model: 'org/m3' } });
    expect(sm.getLayer({ scope: 'defaults' }).llm, '模型 id 里带斜杠也拆得对').toEqual({
      provider: B,
      model: 'org/m3',
    });

    await sm.updateLayer({ scope: 'defaults' }, { llm: null });
    expect(preferred()).toBeUndefined();
    expect(documented()).toBeUndefined();
    expect(sm.getLayer({ scope: 'defaults' })).toEqual({ persona: '<默认人设>' });
  });

  it('配置文件里写了 sessionConfig.defaults.llm：告警一次后忽略，按层写时从文档删掉', async () => {
    const { sm, warns, sessionConfig } = await setup({ defaults: { llm: { provider: A, model: 'm2' } } });
    const mine = await sm.createSession({}, { createdFrom: 'webui' });

    expect(sm.resolveConfig(mine.id).llm).toBeUndefined();
    expect(sm.getLayer({ scope: 'defaults' })).toEqual({});
    expect(warns.filter(w => w.includes('sessionConfig.defaults') && w.includes('llm'))).toHaveLength(1);

    await sm.updateLayer({ scope: 'defaults' }, { persona: '<默认人设>' });
    expect(sessionConfig()).toEqual({ defaults: { persona: '<默认人设>' } });
  });

  it('会话的生效配置在全局默认之上各层都没设时不给值：取用方落到偏好指向的模型，继承链照样写出它来自全局默认', async () => {
    const { sm, resolve } = await setup({ platforms: { onebot: { llm: { provider: A, model: 'm1' } } } });
    await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: A, model: 'm2' } });
    const mine = await sm.createSession({}, { createdFrom: 'webui' });

    expect(sm.resolveConfig(mine.id, 'webui').llm).toBeUndefined();
    expect(resolve(sm.resolveConfig(mine.id, 'webui').llm)).toBe(`${A}/m2`);
    expect(sm.resolveInheritance(mine.id, 'webui')).toMatchObject({
      values: { llm: { provider: A, model: 'm2' } },
      sources: { llm: 'defaults' },
    });
    expect(sm.childConfig(mine.id, 'webui').llm, '建子会话不把默认模型冻结进去').toBeUndefined();
    expect(sm.resolveConfig(mine.id, 'onebot').llm, '上面的层设了照常给').toEqual({ provider: A, model: 'm1' });
  });

  it('偏好指向的模型不在：按层读照样写出所选的那一个，取用方回落到服务解析到的模型', async () => {
    const { sm, resolve } = await setup();
    await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: A, model: 'gone' } });
    const mine = await sm.createSession({}, { createdFrom: 'webui' });

    expect(sm.getLayer({ scope: 'defaults' }).llm).toEqual({ provider: A, model: 'gone' });
    expect(resolve(sm.resolveConfig(mine.id).llm)).toBe(`${A}/m1`);
  });

  it('偏好指向的模型不在、提供者还装着：按这个提供者拆，模型 id 里的斜杠留在模型里', async () => {
    const { sm, host } = await setup();
    host.services.prefer(llm, `${A}/org/gone`);
    expect(sm.getLayer({ scope: 'defaults' }).llm).toEqual({ provider: A, model: 'org/gone' });
  });

  it('偏好只写了提供者（没有模型段）：读不成模型引用，不拆成 npm scope 与包名', async () => {
    const { sm, host } = await setup();
    host.services.prefer(llm, B);
    expect(sm.getLayer({ scope: 'defaults' }).llm).toBeUndefined();
    host.services.prefer(llm, '@zz/llm-gone');
    expect(sm.getLayer({ scope: 'defaults' }).llm, '提供者不在也一样').toBeUndefined();
  });

  it('偏好不是模型引用的写法（手写的、不带斜杠）：改全局默认层的别的项不动偏好', async () => {
    const { sm, host, preferred, documented, sessionConfig } = await setup();
    host.services.prefer(llm, 'gpt-4o');
    host.hostConfig.require().setServicePreference('llm', 'gpt-4o');

    await sm.updateLayer({ scope: 'defaults' }, { persona: '<默认人设>' });
    expect(preferred()).toBe('gpt-4o');
    expect(documented()).toBe('gpt-4o');
    expect(sessionConfig()).toEqual({ defaults: { persona: '<默认人设>' } });
  });

  it('偏好从别处改了：发 session:config:changed，按层读到的是新偏好', async () => {
    const { sm, host } = await setup();
    let changes = 0;
    host.events.on('session:config:changed', () => void changes++);

    host.services.prefer(llm, `${A}/m1`);
    await vi.waitFor(() => expect(changes).toBeGreaterThan(0));
    expect(sm.getLayer({ scope: 'defaults' }).llm).toEqual({ provider: A, model: 'm1' });
  });

  it('llm 的提供者下线：发一次 session:config:changed，服务实际用的那一个随之变', async () => {
    const { app, sm, host } = await setup();
    let changes = 0;
    host.events.on('session:config:changed', () => void changes++);
    host.services.prefer(llm, `${A}/m1`);
    await vi.waitFor(() => expect(changes).toBe(1));

    await app.plugins.unload(A);
    await vi.waitFor(() => expect(changes).toBe(2));
    await new Promise<void>(r => setTimeout(r, 20));
    expect(changes, '下线只发一次').toBe(2);
    expect(sm.resolvedDefaults()).toEqual({ llm: { provider: B, model: 'org/m3' } });
  });

  it('落盘失败：偏好与文档都撤回，以拒绝传出', async () => {
    const save = vi.fn(async () => Promise.reject(new Error('ENOSPC: 磁盘已满')));
    const { sm, preferred, documented, sessionConfig, host } = await setup(
      { defaults: { persona: '<默认人设>' } },
      save,
    );
    host.services.prefer(llm, `${A}/m1`);
    host.hostConfig.require().setServicePreference('llm', `${A}/m1`);

    await expect(
      sm.updateLayer({ scope: 'defaults' }, { llm: { provider: A, model: 'm2' }, persona: null }),
    ).rejects.toThrow('ENOSPC');
    expect(preferred()).toBe(`${A}/m1`);
    expect(documented()).toBe(`${A}/m1`);
    expect(sessionConfig()).toEqual({ defaults: { persona: '<默认人设>' } });

    await expect(sm.updateLayer({ scope: 'defaults' }, { llm: null })).rejects.toThrow('ENOSPC');
    expect(preferred()).toBe(`${A}/m1`);
    expect(documented()).toBe(`${A}/m1`);
  });

  it('服务此刻实际用的那一个：没有偏好时按注册先后，有偏好时是它，偏好指向的模型不在时是服务落到的那一个；只给由偏好承担的项', async () => {
    const { sm } = await setup();
    expect(sm.resolvedDefaults()).toEqual({ llm: { provider: A, model: 'm1' } });
    await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: B, model: 'org/m3' } });
    expect(sm.resolvedDefaults()).toEqual({ llm: { provider: B, model: 'org/m3' } });
    await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: A, model: 'gone' } });
    expect(sm.resolvedDefaults()).toEqual({ llm: { provider: A, model: 'm1' } });
  });

  it('没有可用的模型时，服务实际用的那一个没有', async () => {
    const { app, sm } = await startSessionManager({ settings: [MODEL, PERSONA] });
    apps.push(app);
    expect(sm.resolvedDefaults()).toEqual({});
  });

  it('全局默认以外的层照常存值：平台档的模型写在 sessionConfig.platforms 里，不动偏好', async () => {
    const { sm, preferred, sessionConfig } = await setup();
    await sm.updateLayer({ scope: 'platform', platform: 'onebot' }, { llm: { provider: A, model: 'm1' } });
    expect(sessionConfig()).toEqual({ platforms: { onebot: { llm: { provider: A, model: 'm1' } } } });
    expect(preferred()).toBeUndefined();
  });
});

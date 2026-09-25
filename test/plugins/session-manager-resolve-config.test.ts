import { App, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// resolveConfig 的继承链：会话 config > 父 sessionDefaults > 平台 profile > 全局 defaults。
//
// 回归事故：清除会话覆盖（/model 复位、WebUI 清空）写入 undefined，经 BSON 持久化
// 读回来是 null。stripUndefined 当时只剥 undefined，于是 `llm: null` 在 Object.assign
// 里把平台 profile 覆盖成空 → agent 判 ref 不成立 → resolveLLMModel(undefined) 静默
// 落到首个注册的 entry。实况表现：配置里写着 qwen3.6:35b-mlx，实际跑 gemma4:e4b，
// 全程零告警。契约：null 与 undefined 同义，都表示「未设置，继承上层」。
// ════════════════════════════════════════════════════════════

async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, sessionManager });
  host.provide(memory, fakeMemory() as never);
  await app.plugin(sessionManagerPlugin, {
    platformProfiles: [
      {
        platform: 'onebot',
        persona: 'aalis',
        llm: { provider: '@aalis/plugin-llm-ollama', model: 'qwen3.6:35b-mlx' },
        think: true,
      },
    ],
  });
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错——核激活状态，别让「压根没跑起来」冒充绿
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  return { app, sm: host.sessionManager.require() };
}

describe('resolveConfig：null 与 undefined 同义（都表示继承上层）', () => {
  it('会话 config 为 llm:null 时，仍继承平台 profile 的模型（不静默落回首个 entry）', async () => {
    const { app, sm } = await setup();
    const id = 'onebot:bot:private:u1';
    // 复现持久化读回来的形状：清除覆盖写 undefined → BSON 存成 null
    await sm.ensureSession(id, { config: { llm: null, persona: null } as never });

    const resolved = sm.resolveConfig(id, 'onebot');
    expect(resolved.llm, 'null 不该把 profile 的模型盖掉').toEqual({
      provider: '@aalis/plugin-llm-ollama',
      model: 'qwen3.6:35b-mlx',
    });
    expect(resolved.persona).toBe('aalis');
    await app.stop();
  });

  it('会话 config 有真实覆盖时仍然优先于平台 profile', async () => {
    const { app, sm } = await setup();
    const id = 'onebot:bot:private:u2';
    await sm.ensureSession(id, {
      config: { llm: { provider: '@aalis/plugin-llm-ollama', model: 'gemma4:26b-mlx' } } as never,
    });

    const resolved = sm.resolveConfig(id, 'onebot');
    expect(resolved.llm).toEqual({ provider: '@aalis/plugin-llm-ollama', model: 'gemma4:26b-mlx' });
    // 未覆盖的字段照常继承 profile
    expect(resolved.persona).toBe('aalis');
    await app.stop();
  });

  it('未建档的会话也照常拿到平台 profile', async () => {
    const { app, sm } = await setup();
    const resolved = sm.resolveConfig('onebot:bot:group:never-seen', 'onebot');
    expect(resolved.llm).toEqual({ provider: '@aalis/plugin-llm-ollama', model: 'qwen3.6:35b-mlx' });
    await app.stop();
  });
});

describe('resolveConfig：think 会话覆盖（/session.set -t 的存储层契约）', () => {
  it('think:false 是合法覆盖值，不被 strip——压过 profile 的 think:true', async () => {
    const { app, sm } = await setup();
    const id = 'onebot:bot:private:t1';
    await sm.ensureSession(id, { config: { think: false } });
    // 关键回归：false 是 falsy，stripUndefined 若误剥 falsy 值，这里会错误回落 profile 的 true
    expect(sm.resolveConfig(id, 'onebot').think).toBe(false);
    await app.stop();
  });

  it('清除覆盖（undefined 与 BSON 读回的 null）→ 回落 profile 的 think:true', async () => {
    const { app, sm } = await setup();
    const id = 'onebot:bot:private:t2';
    await sm.ensureSession(id, { config: { think: false } });
    await sm.ensureSession(id, { config: { think: undefined } });
    expect(sm.resolveConfig(id, 'onebot').think, 'undefined 应回落 profile').toBe(true);
    await sm.ensureSession(id, { config: { think: null } as never });
    expect(sm.resolveConfig(id, 'onebot').think, 'null 与 undefined 同义').toBe(true);
    await app.stop();
  });

  it('无 profile 的平台上未设置 think → resolved 不含 think（agent 不带 think 字段发请求）', async () => {
    const { app, sm } = await setup();
    expect(sm.resolveConfig('webui:someone', 'webui').think).toBeUndefined();
    await app.stop();
  });
});

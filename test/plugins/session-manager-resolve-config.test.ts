import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { SessionManagerService } from '../../packages/api-session-manager/src/index.js';
import * as sessionManagerModule from '../../packages/plugin-session-manager/src/index.js';

// ════════════════════════════════════════════════════════════
// resolveConfig 的继承链：会话 config > 父 sessionDefaults > 平台 profile > 全局 defaults。
//
// 回归事故：清除会话覆盖（/model 复位、WebUI 清空）写入 undefined，经 BSON 持久化
// 读回来是 null。stripUndefined 当时只剥 undefined，于是 `llm: null` 在 Object.assign
// 里把平台 profile 覆盖成空 → agent 判 ref 不成立 → resolveLLMModel(undefined) 静默
// 落到首个注册的 entry。实况表现：配置里写着 qwen3.6:35b-mlx，实际跑 gemma4:e4b，
// 全程零告警。契约：null 与 undefined 同义，都表示「未设置，继承上层」。
// ════════════════════════════════════════════════════════════

/** 只实现 SessionManager 用到的四个方法的假 memory。 */
function fakeMemory() {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    listMetadata: async () => [...meta].map(([key, data]) => ({ key, data })),
    commitMetadata: async (ops: Array<{ op: string; key: string; data?: Record<string, unknown> }>) => {
      for (const o of ops) {
        if (o.op === 'put' && o.data) meta.set(o.key, o.data);
        else if (o.op === 'del') meta.delete(o.key);
      }
    },
    getHistory: async () => [],
    clearSession: async () => {},
  };
}

async function setup() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  app.ctx.provide('memory', fakeMemory() as never);
  await app.ctx.useModule(sessionManagerModule, {
    platformProfiles: [
      { platform: 'onebot', persona: 'aalis', llm: { provider: '@aalis/plugin-llm-ollama', model: 'qwen3.6:35b-mlx' } },
    ],
  });
  await app.plugins.idle();
  const sm = app.ctx.getService<SessionManagerService>('session-manager');
  if (!sm) throw new Error('session-manager 服务未注册');
  return { app, sm };
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

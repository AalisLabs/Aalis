import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../packages/core/src/index.js';
import { MODEL, PERSONA, startSessionManager, THINK } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// resolveConfig 的继承链：会话 config > 父 sessionDefaults > 平台档 > 全局默认。
//
// 回归事故：清除会话覆盖（/model 复位、WebUI 清空）写入 undefined，经 BSON 持久化
// 读回来是 null。当时只剥 undefined，于是 `llm: null` 在合并里把平台档覆盖成空 → agent 判 ref 不成立
// → resolveLLMModel(undefined) 静默落到首个注册的 entry。实况表现：配置里写着 qwen3.6:35b-mlx，实际跑 gemma4:e4b，
// 全程零告警。契约：null 与 undefined 同义，都表示「未设置，继承上层」。
// ════════════════════════════════════════════════════════════

const ONEBOT_MODEL = { provider: '@aalis/plugin-llm-ollama', model: 'qwen3.6:35b-mlx' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** stored：会话表里预置的会话自身 config（复现经 BSON 落盘读回来的形状） */
async function setup(stored: Record<string, Record<string, unknown>> = {}) {
  const { app, sm } = await startSessionManager({
    layers: { platforms: { onebot: { persona: 'aalis', llm: ONEBOT_MODEL, think: true } } },
    settings: [MODEL, THINK, PERSONA],
    stored: Object.fromEntries(
      Object.entries(stored).map(([id, config]) => [id, { id, name: id, children: [], status: 'waiting', config }]),
    ),
  });
  apps.push(app);
  return sm;
}

describe('resolveConfig：null 与 undefined 同义（都表示继承上层）', () => {
  it('会话 config 为 llm:null 时，仍继承平台档的模型（不静默落回首个 entry）', async () => {
    const id = 'onebot:bot:private:u1';
    const sm = await setup({ [id]: { llm: null, persona: null } });

    const resolved = sm.resolveConfig(id, 'onebot');
    expect(resolved.llm, 'null 不该把平台档的模型盖掉').toEqual(ONEBOT_MODEL);
    expect(resolved.persona).toBe('aalis');
  });

  it('会话 config 有真实覆盖时仍然优先于平台档', async () => {
    const sm = await setup();
    const id = 'onebot:bot:private:u2';
    await sm.ensureSession(id, { config: { llm: { provider: '@aalis/plugin-llm-ollama', model: 'gemma4:26b-mlx' } } });

    const resolved = sm.resolveConfig(id, 'onebot');
    expect(resolved.llm).toEqual({ provider: '@aalis/plugin-llm-ollama', model: 'gemma4:26b-mlx' });
    // 未覆盖的字段照常继承平台档
    expect(resolved.persona).toBe('aalis');
  });

  it('未建档的会话也照常拿到平台档', async () => {
    const sm = await setup();
    expect(sm.resolveConfig('onebot:bot:group:never-seen', 'onebot').llm).toEqual(ONEBOT_MODEL);
  });
});

describe('resolveConfig：think 会话覆盖（/session.set -t 的存储层契约）', () => {
  it('think:false 是合法覆盖值，不被剥掉——压过平台档的 think:true', async () => {
    const sm = await setup();
    const id = 'onebot:bot:private:t1';
    await sm.ensureSession(id, { config: { think: false } });
    // 关键回归：false 是 falsy，若误剥 falsy 值，这里会错误回落平台档的 true
    expect(sm.resolveConfig(id, 'onebot').think).toBe(false);
  });

  it('清除覆盖（写 null，或 BSON 读回的 null）→ 回落平台档的 think:true', async () => {
    const stored = 'onebot:bot:private:t3';
    const sm = await setup({ [stored]: { think: null } });
    const id = 'onebot:bot:private:t2';
    await sm.ensureSession(id, { config: { think: false } });
    await sm.ensureSession(id, { config: { think: null } });
    expect(sm.resolveConfig(id, 'onebot').think, 'null 删掉覆盖').toBe(true);
    expect(sm.resolveConfig(stored, 'onebot').think, '存储里读回的 null 与没有同义').toBe(true);
  });

  it('没有平台档的平台上未设置 think → 解析结果不含 think（agent 不带 think 字段发请求）', async () => {
    const sm = await setup();
    expect(sm.resolveConfig('webui:someone', 'webui').think).toBeUndefined();
  });
});

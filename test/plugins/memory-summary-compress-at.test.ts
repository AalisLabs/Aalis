import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { compression, memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { isSessionSettingsError, sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { endTurn, fakeSummaryLLM } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 自动压缩线是摘要插件的按会话字段 compressAt：占窗口比例，0 到 1，作者默认 0.8，0 表示不按用量压缩，只有 owner 能改。
// 全局层是插件配置；各会话按会话设置的各层取（层的先后由会话设置的用例钉住），没有出生平台的会话按入口平台选平台档。
// 会话设置不在时取插件配置。
// ════════════════════════════════════════════════════════════

const ID = memorySummary.name;
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** settings 为 false 时不装会话设置 */
async function setup(doc: Partial<AalisConfig> = {}, { settings = true } = {}) {
  const { app, store } = hostedApp(doc);
  apps.push(app);
  await registerHubs(app);
  const summaryLLM = fakeSummaryLLM();
  const host = app.bind({ provide, events, hooks, memory, compression, sessionManager, sessionSettings });
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  if (settings) await app.plugin(sessionSettingsPlugin);
  host.provide.use(llm, summaryLLM.model);
  await registerFromDoc(app, store, memorySummary);
  await app.plugins.idle();
  if (app.plugins.getPlugin(ID)?.state !== 'active') throw new Error('plugin-memory-summary 未激活');
  const sm = host.sessionManager.use;
  const owner = await sm.createSession({ name: '本机会话' });
  /** 写这个会话本会话层的压缩线（会话设置的写入口，校验与门槛以外的写法同协议） */
  const setOwn = (sessionId: string, value: unknown) =>
    host.sessionSettings.use.update({ sessionId }, { plugin: ID, key: 'compressAt', value });
  return { host, sm, owner, summaryLLM, setOwn, compressAt: host.compression.use.compressAt };
}

describe('plugin-memory-summary：自动压缩线', () => {
  it('按会话字段：0 到 1，作者默认 0.8，高级，适用全部会话，只有 owner 能改', async () => {
    expect(memorySummary.configSchema?.compressAt).toMatchObject({
      type: 'number',
      min: 0,
      max: 1,
      default: 0.8,
      session: { prominence: 'advanced' },
    });
    expect(
      (memorySummary.configSchema?.compressAt as { session: { appliesTo?: unknown } }).session.appliesTo,
    ).toBeUndefined();
    const { host } = await setup();
    expect(host.sessionSettings.use.getAll().find(entry => entry.key === 'compressAt')).toEqual({
      plugin: ID,
      key: 'compressAt',
      label: expect.anything(),
    });
  });

  it('哪一层都没设时取插件配置；插件配置没写时 0.8', async () => {
    expect((await setup()).compressAt('<任意会话>', 'webui')).toBe(0.8);
    const { owner, compressAt } = await setup({ plugins: { [ID]: { compressAt: 0.5 } } });
    expect(compressAt(owner.id, 'webui')).toBe(0.5);
  });

  it('会话自己的值压过插件配置；没有出生平台的会话按入口平台选平台档', async () => {
    const { sm, owner, setOwn, compressAt } = await setup({
      plugins: { [ID]: { compressAt: 0.5 } },
      sessionConfig: { platforms: { webui: { [ID]: { compressAt: 0.3 } } } },
    });
    expect([compressAt(owner.id, 'webui'), compressAt(owner.id, 'cli')]).toEqual([0.3, 0.5]);
    const other = await sm.createSession({ name: '另一个会话' });
    await setOwn(owner.id, 0.1);
    expect([compressAt(owner.id, 'webui'), compressAt(other.id, 'webui')]).toEqual([0.1, 0.3]);
  });

  it('会话设置不在：取插件配置', async () => {
    const { owner, compressAt } = await setup({ plugins: { [ID]: { compressAt: 0.5 } } }, { settings: false });
    expect(compressAt(owner.id, 'webui')).toBe(0.5);
  });

  it.each([1.5, -0.1])('写 %d 被拒', async value => {
    const { owner, setOwn } = await setup();
    await expect(setOwn(owner.id, value)).rejects.toSatisfy(isSessionSettingsError);
  });

  it('设为 0：压缩线为 undefined，用量到线的回合结束也不压缩；手动压缩照常', async () => {
    const { host, owner, setOwn, summaryLLM, compressAt } = await setup();
    await setOwn(owner.id, 0);
    expect(compressAt(owner.id, 'webui')).toBeUndefined();
    await host.memory.use.saveMessage(owner.id, { role: 'user', content: '在吗' });

    await endTurn(host, owner.id, { used: 990, compressible: 900 });
    await new Promise<void>(r => setTimeout(r, 20));
    expect(summaryLLM.requests).toHaveLength(0);

    await host.compression.use.compress(owner.id, { reason: 'manual' });
    expect(summaryLLM.requests).toHaveLength(1);
  });

  it('回合结束的判定按会话与用量事件上的平台取压缩线', async () => {
    const { host, sm, owner, summaryLLM } = await setup({
      sessionConfig: { platforms: { webui: { [ID]: { compressAt: 0.3 } } } },
    });
    const other = await sm.createSession({ name: '终端会话' });
    for (const id of [owner.id, other.id]) await host.memory.use.saveMessage(id, { role: 'user', content: '在吗' });

    // 有效阈值：webui 平台档 0.3 × 1000 = 300；cli 没有平台档，按默认 0.8 为 800
    await endTurn(host, other.id, { used: 400, compressible: 400 }, { platform: 'cli' });
    await new Promise<void>(r => setTimeout(r, 20));
    expect(summaryLLM.requests).toHaveLength(0);

    await endTurn(host, owner.id, { used: 400, compressible: 400 }, { platform: 'webui' });
    await expect.poll(() => summaryLLM.requests.map(r => r.sessionId)).toEqual([owner.id]);
  });
});

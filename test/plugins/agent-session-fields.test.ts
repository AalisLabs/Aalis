import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService, type TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import {
  type ChatModelRequest,
  type LLMModel,
  llm,
  type ModelRef,
  type ThinkingLevels,
} from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { isSessionSettingsError, sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, events, lifecycle, provide, services } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// agent 的四项按会话设置（模型、深度思考、最大工具迭代、历史条数上限）：字段写在 agent 的 configSchema 上，每一轮经读取器
// 按这个会话现读，改了下一轮起生效、不重载插件。模型没设时交给服务选择（本插件偏好 › 全局偏好 › 优先级）；会话设置不在时
// 读插件配置。assignModel 经读取器写这个会话本会话层的模型；字段登记时交的 actual 与回合里挑的是同一个模型。用量事件
// 带这一轮的历史条数上限。各会话用了哪个模型看替身模型服务收到的请求。
// ════════════════════════════════════════════════════════════

const PROVIDER = 'zz-llm';
const DEEP: ThinkingLevels = {
  levels: [
    { id: 'off', label: '关' },
    { id: 'max', label: '最高' },
  ],
  default: 'off',
};
const PROBE = 'zz_fields_probe';

type Sent = { model: string; request: ChatModelRequest };

/** 两个对话模型：a 不能调深度思考，b 有关与最高两档；每次请求记进 sent。toolTurns 为真时每次都要求调一次探针工具 */
function models(sent: Sent[], toolTurns: () => boolean) {
  return definePlugin({
    name: PROVIDER,
    provides: [llm],
    uses: { provide, lifecycle },
    apply(caps) {
      for (const [id, thinking] of [
        ['a', undefined],
        ['b', DEEP],
      ] as const) {
        const reply = () =>
          toolTurns()
            ? { toolCalls: [{ id: 'c1', type: 'function' as const, function: { name: PROBE, arguments: '{}' } }] }
            : { contentDelta: `好 ${sent.length}` };
        const handle: LLMModel = {
          id,
          providerId: caps.lifecycle.use.id,
          contextLength: 1_000_000,
          maxOutputTokens: 1024,
          capabilities: ['chat', 'streaming', 'tool_calling'],
          ...(thinking ? { thinking } : {}),
          async chat(request) {
            sent.push({ model: id, request });
            return { content: 'ok' };
          },
          async *chatStream(request) {
            sent.push({ model: id, request });
            const next = reply();
            if ('contentDelta' in next) yield next;
            yield { done: true, ...('toolCalls' in next ? next : {}) };
          },
        };
        caps.provide.use(llm, handle, { entryId: `${caps.lifecycle.use.id}/${id}` });
      }
    },
  });
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot({ settings = true, doc = {} }: { settings?: boolean; doc?: Partial<AalisConfig> } = {}) {
  const sent: Sent[] = [];
  let toolTurns = false;
  const { app, store } = hostedApp(doc);
  apps.push(app);
  await registerHubs(app);
  const definitions = [
    models(sent, () => toolTurns),
    toolsPlugin,
    memoryInMemoryPlugin,
    messageArchivePlugin,
    sessionManagerPlugin,
    ...(settings ? [sessionSettingsPlugin] : []),
    agentPlugin,
  ];
  for (const definition of definitions) await registerFromDoc(app, store, definition);
  await app.plugins.idle();
  for (const { name } of definitions) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }
  const host = app.bind({ agent: agentService, tools, events, services, sessionManager });
  let executed = 0;
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => {
      executed++;
      return 'ok';
    },
  });
  const usages: TokenUsageEvent[] = [];
  host.events.use.on('token:usage', usage => void usages.push(usage));
  const ask = (sessionId: string, platform = 'webui') =>
    host.agent.use.handleMessage({ content: '在吗', sessionId, platform, userId: 'u1' });
  const admin = () => app.bind({ sessionSettings }).sessionSettings.use;
  /** 写这个会话本会话层的一项（会话先建档） */
  const set = async (sessionId: string, key: string, value: unknown) => {
    await host.sessionManager.use.ensureSession(sessionId);
    await admin().update({ sessionId }, { plugin: agentPlugin.name, key, value });
  };
  return {
    app,
    host,
    sent,
    usages,
    ask,
    admin,
    set,
    executed: () => executed,
    toolTurns(on: boolean) {
      toolTurns = on;
      executed = 0;
    },
  };
}

const ref = (model: string): ModelRef => ({ provider: PROVIDER, model });

describe('字段声明', () => {
  it('四项写在 agent 的 configSchema 上，可按会话覆盖；模型的全局层是本插件的 llm 偏好', () => {
    const {
      llm: model,
      think,
      maxToolIterations,
      historyLimit,
    } = agentPlugin.configSchema as unknown as Record<string, Record<string, unknown>>;
    expect(model).toMatchObject({
      type: 'llm-ref',
      session: { preference: 'llm', prominence: 'composer', minLevel: 1 },
    });
    expect(model.default).toBeUndefined();
    expect(think).toMatchObject({
      type: 'select',
      dynamicOptions: 'llm-thinking',
      session: { dependsOn: 'llm', prominence: 'common', order: 20, minLevel: 1 },
    });
    expect(maxToolIterations).toMatchObject({
      type: 'number',
      integer: true,
      min: 1,
      session: { prominence: 'advanced', unset: expect.anything() },
    });
    expect(maxToolIterations.default, '没设即不限').toBeUndefined();
    expect(historyLimit).toMatchObject({
      type: 'number',
      integer: true,
      min: 0,
      default: 0,
      session: { prominence: 'advanced' },
    });
    for (const field of [maxToolIterations, historyLimit]) {
      expect((field.session as { minLevel?: number }).minLevel, '只有 owner 能改').toBeUndefined();
    }
  });
});

describe('每一轮按会话读', () => {
  it('本会话层设的模型、深度思考、工具迭代上限与历史条数线下一轮起生效，别的会话不受影响', async () => {
    const s = await boot();
    await s.ask('s1');
    expect(s.sent.at(-1)?.model, '没设时按服务选择取第一个模型').toBe('a');

    await s.set('s1', 'llm', ref('b'));
    await s.set('s1', 'think', 'max');
    await s.set('s1', 'historyLimit', 4);
    await s.ask('s1');
    expect(s.sent.at(-1)).toMatchObject({ model: 'b', request: { think: 'max' } });
    expect(s.usages.at(-1)?.historyLimit).toBe(4);

    s.toolTurns(true);
    await s.set('s1', 'maxToolIterations', 2);
    await s.ask('s1');
    expect(s.executed(), '工具迭代上限').toBe(2);

    s.toolTurns(false);
    await s.ask('s2');
    expect(s.sent.at(-1)?.model).toBe('a');
    expect('think' in (s.sent.at(-1)?.request ?? {})).toBe(false);
    expect(s.usages.at(-1)?.historyLimit).toBe(0);
  });

  it('模型的档位里没有设的那一档时请求不带 think', async () => {
    const s = await boot();
    await s.set('s1', 'think', 'max');
    await s.ask('s1');
    expect(s.sent.at(-1)?.model).toBe('a');
    expect('think' in (s.sent.at(-1)?.request ?? {})).toBe(false);
  });

  it('模型没设时落到本插件偏好，再落到全局偏好', async () => {
    const s = await boot();
    s.host.services.use.prefer(llm, `${PROVIDER}/b`);
    await s.ask('s1');
    expect(s.sent.at(-1)?.model, '全局偏好').toBe('b');
    s.host.services.use.prefer(llm, `${PROVIDER}/a`, { for: agentPlugin.name });
    await s.ask('s1');
    expect(s.sent.at(-1)?.model, '本插件偏好压过全局偏好').toBe('a');
    await s.set('s1', 'llm', ref('b'));
    await s.ask('s1');
    expect(s.sent.at(-1)?.model, '会话设了的压过偏好').toBe('b');
  });

  it('会话设置不在时读 agent 的插件配置', async () => {
    const s = await boot({
      settings: false,
      doc: { plugins: { [agentPlugin.name]: { think: 'max', maxToolIterations: 3, historyLimit: 6 } } },
    });
    s.host.services.use.prefer(llm, `${PROVIDER}/b`, { for: agentPlugin.name });
    s.toolTurns(true);
    await s.ask('s1');
    expect(s.executed()).toBe(3);
    expect(s.sent.at(-1)).toMatchObject({ model: 'b', request: { think: 'max' } });
    expect(s.usages.at(-1)?.historyLimit).toBe(6);
  });
});

describe('assignModel 与 actual', () => {
  it('assignModel 写这个会话本会话层的模型；会话设置不在时抛错', async () => {
    const s = await boot();
    const child = await s.host.sessionManager.use.createSession({ name: '子会话' });
    await s.host.agent.use.assignModel(child.id, ref('b'));
    const row = s
      .admin()
      .rows({ sessionId: child.id })
      .find(r => r.plugin === agentPlugin.name && r.key === 'llm');
    expect(row).toMatchObject({ value: ref('b'), source: 'session' });
    await s.ask(child.id);
    expect(s.sent.at(-1)?.model).toBe('b');

    const absent = await boot({ settings: false });
    const err = await absent.host.agent.use.assignModel('s1', ref('b')).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isSessionSettingsError(err), String(err)).toBe(true);
  });

  it('模型哪一层都没设时的 actual 就是回合里挑的那个模型（同一份同步解析，只交取值，界面按模型名写），全局偏好改了随之变；本插件偏好就是全局层', async () => {
    const s = await boot();
    const owner = await s.host.sessionManager.use.createSession({ name: '本机会话' }, { createdFrom: 'webui' });
    const row = () =>
      s
        .admin()
        .rows({ sessionId: owner.id, at: { platform: 'webui' } })
        .find(r => r.key === 'llm');
    await s.ask(owner.id);
    expect(row()?.actual).toEqual({ value: ref(s.sent.at(-1)!.model) });
    s.host.services.use.prefer(llm, `${PROVIDER}/b`);
    await s.ask(owner.id);
    expect(s.sent.at(-1)?.model).toBe('b');
    expect(row()?.actual?.value).toEqual(ref('b'));

    s.host.services.use.prefer(llm, `${PROVIDER}/a`, { for: agentPlugin.name });
    await s.ask(owner.id);
    expect(s.sent.at(-1)?.model).toBe('a');
    expect(row()).toMatchObject({ effective: ref('a'), source: 'global' });
    expect(row()?.actual).toBeUndefined();
  });
});

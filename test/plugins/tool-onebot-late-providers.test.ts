import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { sessionHistory } from '../../packages/api-tool-session/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, optional, provide } from '../../packages/core/src/index.js';
import toolOnebot from '../../packages/plugin-tool-onebot/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// tool-onebot 与可选依赖的上线顺序无关。
//
// 1. 会话历史访问规则挂在 session-history 提供者实例的局部状态上：tool-session 重启、
//    晚于本插件上线，规则都要重挂到新实例；不能只在 app:ready 那一刻对 current 注册一次。
//    规则只对 onebot 会话 id 表态，与 OneBot 平台在不在场无关。
// 2. OneBot 工具只在出现 OneBot 平台时注册，但适配器可能晚于 app:ready 上线，
//    且作为 platform 的非胜者上线（follow 不触发）：平台出现时补注册一次，之后不重复。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10001:group:20002';
const PRIVATE = 'onebot:10001:private:30003';
const TOOL_ONEBOT = '@aalis/plugin-tool-onebot';
const TOOL_SESSION = '@aalis/plugin-tool-session';

const booted: App[] = [];

afterEach(async () => {
  for (const app of booted.splice(0)) await app.stop();
});

/** 让 service:registered 等异步通知落地 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function adapter(name: string): PlatformAdapter {
  return { adapterName: name, platform: name, getConnections: () => [], sendMessage: async () => {} };
}

/** 真实 App；tools / memory 由宿主提供桩实现，记下注册的工具名与注册调用次数 */
async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  booted.push(app);
  const host = app.bind({ provide, history: optional(sessionHistory) });

  const registered = new Set<string>();
  const registerCalls: string[] = [];
  const handlers = new Map<string, RegisteredTool['handler']>();
  host.provide(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      const name = tool.definition.function.name;
      registered.add(name);
      registerCalls.push(name);
      handlers.set(name, tool.handler);
      return () => void registered.delete(name);
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(memory, { getHistory: async () => [] } as never);

  /** 群会话里读取同账号某私聊的历史（直接走 session-history 服务，与通用工具同一条规则链） */
  const readPrivateFromGroup = () => {
    const service = host.history.current;
    if (!service) throw new Error('session-history 不在场');
    return service.getHistory({ sessionId: PRIVATE }, { sessionId: GROUP, platform: 'onebot' } as never);
  };
  const onebotTools = () => [...registered].filter(name => name.startsWith('onebot_'));

  return { app, host, registerCalls, handlers, readPrivateFromGroup, onebotTools };
}

const DENIED = { error: expect.stringContaining('不允许从群聊读取私聊历史') };

describe('tool-onebot 会话历史访问规则跟随 session-history 提供者', () => {
  it('tool-session 重启后，群聊读私聊仍被拒', async () => {
    const { app, host, readPrivateFromGroup } = await setup();
    host.provide(platform, adapter('onebot'));
    await app.pluginAll([{ definition: sessionTools }, { definition: toolOnebot }]);
    await app.start();
    await app.plugins.idle();
    expect(await readPrivateFromGroup()).toEqual(DENIED);

    expect(await app.plugins.bounce(TOOL_SESSION)).toBe(true);
    await app.plugins.idle();
    expect(await readPrivateFromGroup(), '规则须重挂到重启后的新实例').toEqual(DENIED);
  });

  it('tool-session 晚于 app:ready 热装：规则随其上线补挂', async () => {
    const { app, host, readPrivateFromGroup } = await setup();
    host.provide(platform, adapter('onebot'));
    await app.plugin(toolOnebot);
    await app.start();
    await app.plugins.idle();
    expect(host.history.current).toBeUndefined();

    await app.plugin(sessionTools);
    await app.plugins.idle();
    expect(await readPrivateFromGroup()).toEqual(DENIED);
  });

  it('规则与 OneBot 平台在不在场无关：没有平台也照样生效', async () => {
    const { app, readPrivateFromGroup, onebotTools } = await setup();
    await app.pluginAll([{ definition: sessionTools }, { definition: toolOnebot }]);
    await app.start();
    await app.plugins.idle();
    expect(onebotTools(), '没有 OneBot 平台不注册工具').toEqual([]);
    expect(await readPrivateFromGroup()).toEqual(DENIED);
  });

  it('tool-onebot 卸载后规则随之撤回，不留在 session-history 上', async () => {
    const { app, readPrivateFromGroup } = await setup();
    await app.pluginAll([{ definition: sessionTools }, { definition: toolOnebot }]);
    await app.start();
    await app.plugins.idle();
    expect(await readPrivateFromGroup()).toEqual(DENIED);

    expect(await app.plugins.unload(TOOL_ONEBOT)).toBe(true);
    await app.plugins.idle();
    expect(await readPrivateFromGroup()).toMatchObject({ ok: true, sessionId: PRIVATE });
  });
});

describe('tool-onebot 平台闸可重入', () => {
  it('OneBot 适配器在 app:ready 之后才上线、且不是 platform 胜者：工具随后注册', async () => {
    const { app, host, onebotTools } = await setup();
    host.provide(platform, adapter('cli'));
    await app.plugin(toolOnebot);
    await app.start();
    await app.plugins.idle();
    expect(onebotTools()).toEqual([]);

    host.provide(platform, adapter('onebot'));
    await flush();
    expect(onebotTools()).toEqual(expect.arrayContaining(['onebot_group_ban', 'onebot_resolve_session_id']));
  });

  it('OneBot 平台再次注册时不重复注册工具', async () => {
    const { app, host, registerCalls } = await setup();
    host.provide(platform, adapter('onebot'));
    await app.plugin(toolOnebot);
    await app.start();
    await app.plugins.idle();
    const count = registerCalls.length;
    expect(count).toBeGreaterThan(0);

    host.provide(platform, adapter('onebot'));
    await flush();
    expect(registerCalls).toHaveLength(count);
  });
});

describe('tool-onebot 在适配器缺非契约扩展时的回退文案', () => {
  it('缺 getSentMessages / getSelfMutes：不发 delete_msg，文案不归因于「版本」', async () => {
    const { app, host, handlers } = await setup();
    const actions: string[] = [];
    host.provide(platform, {
      ...adapter('onebot'),
      callAction: async (_sessionId: string, action: string) => {
        actions.push(action);
        return {};
      },
    });
    await app.plugin(toolOnebot);
    await app.start();
    await app.plugins.idle();

    const recallSelf = handlers.get('onebot_recall_self');
    const listSelfMutes = handlers.get('onebot_list_self_mutes');
    if (!recallSelf || !listSelfMutes) throw new Error('OneBot 工具未注册');

    const recalled = String(await recallSelf({}, { sessionId: GROUP } as never));
    expect(actions).toEqual([]);
    expect(recalled).toContain('onebot_delete_msg');
    expect(recalled).not.toContain('版本');

    const mutes = JSON.parse(String(await listSelfMutes({}, { sessionId: GROUP } as never)));
    expect(mutes.supported).toBe(false);
    expect(mutes.reason).not.toContain('版本');
  });
});

describe('tool-onebot 访问规则与专属历史工具开关解耦', () => {
  const HISTORY_OFF = { sessionHistory: { enabled: false } };

  it('sessionHistory.enabled=false：专属历史工具不注册，访问规则照常生效', async () => {
    const { app, host, readPrivateFromGroup, onebotTools } = await setup();
    host.provide(platform, adapter('onebot'));
    await app.pluginAll([{ definition: sessionTools }, { definition: toolOnebot, config: HISTORY_OFF }]);
    await app.start();
    await app.plugins.idle();
    // 平台在场、其它工具照常注册，只少两个专属历史工具
    expect(onebotTools()).toContain('onebot_group_ban');
    expect(onebotTools()).not.toContain('onebot_get_session_history');
    expect(onebotTools()).not.toContain('onebot_resolve_session_id');
    expect(await readPrivateFromGroup(), '关掉专属工具不能放宽通用工具的读取').toEqual(DENIED);
  });

  it('sessionHistory.enabled=false 且 allowGroupReadPrivate=true：放行（规则读 allow*，不读开关）', async () => {
    const { app, readPrivateFromGroup } = await setup();
    await app.pluginAll([
      { definition: sessionTools },
      { definition: toolOnebot, config: { sessionHistory: { enabled: false, allowGroupReadPrivate: true } } },
    ]);
    await app.start();
    await app.plugins.idle();
    expect(await readPrivateFromGroup()).toMatchObject({ ok: true, sessionId: PRIVATE });
  });

  it('sessionHistory.enabled=false 时卸载 tool-onebot：规则随之撤回', async () => {
    const { app, readPrivateFromGroup } = await setup();
    await app.pluginAll([{ definition: sessionTools }, { definition: toolOnebot, config: HISTORY_OFF }]);
    await app.start();
    await app.plugins.idle();
    expect(await readPrivateFromGroup()).toEqual(DENIED);

    expect(await app.plugins.unload(TOOL_ONEBOT)).toBe(true);
    await app.plugins.idle();
    expect(await readPrivateFromGroup()).toMatchObject({ ok: true, sessionId: PRIVATE });
  });
});

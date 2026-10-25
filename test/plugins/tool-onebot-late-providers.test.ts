import { afterEach, describe, expect, it } from 'vitest';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import toolOnebot from '../../packages/plugin-tool-onebot/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// tool-onebot 与可选依赖的上线顺序无关：OneBot 工具只在出现 OneBot 平台时注册，但适配器可能晚于 app:ready 上线，
// 且作为 platform 的非胜者上线（follow 不触发）：平台出现时补注册一次，之后不重复。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10001:group:20002';

const booted: App[] = [];

afterEach(async () => {
  for (const app of booted.splice(0)) await app.stop();
});

/** 让 service:changed 等异步通知落地 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function adapter(name: string): PlatformAdapter {
  return { adapterName: name, platform: name, getConnections: () => [], sendMessage: async () => {} };
}

/** 真实 App；tools 由宿主提供桩实现，记下注册的工具名与注册调用次数 */
async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  booted.push(app);
  const host = app.bind({ provide });

  const registered = new Set<string>();
  const registerCalls: string[] = [];
  const handlers = new Map<string, RegisteredTool['handler']>();
  host.provide.use(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      const name = tool.definition.function.name;
      registered.add(name);
      registerCalls.push(name);
      handlers.set(name, tool.handler);
      return () => void registered.delete(name);
    },
    registerGroup: () => () => {},
  } as never);
  const onebotTools = () => [...registered].filter(name => name.startsWith('onebot_'));

  return { app, host, registerCalls, handlers, onebotTools };
}

describe('tool-onebot 平台闸可重入', () => {
  it('OneBot 适配器在 app:ready 之后才上线、且不是 platform 胜者：工具随后注册', async () => {
    const { app, host, onebotTools } = await setup();
    // 同一激活登记两家：各给一个条目 id，list() 才分得清
    host.provide.use(platform, adapter('cli'), { entryId: 'adapter-cli' });
    await app.plugin(toolOnebot);
    await app.start();
    await app.plugins.idle();
    expect(onebotTools()).toEqual([]);

    host.provide.use(platform, adapter('onebot'), { entryId: 'adapter-onebot' });
    await flush();
    expect(onebotTools()).toEqual(expect.arrayContaining(['onebot_group_ban', 'onebot_resolve_session_id']));
  });

  it('OneBot 平台再次注册时不重复注册工具', async () => {
    const { app, host, registerCalls } = await setup();
    host.provide.use(platform, adapter('onebot'));
    await app.plugin(toolOnebot);
    await app.start();
    await app.plugins.idle();
    const count = registerCalls.length;
    expect(count).toBeGreaterThan(0);

    host.provide.use(platform, adapter('onebot'));
    await flush();
    expect(registerCalls).toHaveLength(count);
  });
});

describe('tool-onebot 在适配器缺非契约扩展时报错', () => {
  it('缺 getSentMessages / getSelfMutes：报错、不发 delete_msg，原因不归因于「版本」', async () => {
    const { app, host, handlers } = await setup();
    const actions: string[] = [];
    host.provide.use(platform, {
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

    const failure = (run: Promise<unknown>) =>
      run.then(
        () => '',
        (err: Error) => err.message,
      );
    const recalled = await failure(recallSelf({}, { sessionId: GROUP } as never));
    expect(actions).toEqual([]);
    expect(recalled).toContain('onebot_delete_msg');
    expect(recalled).not.toContain('版本');

    const mutes = await failure(listSelfMutes({}, { sessionId: GROUP } as never));
    expect(mutes).toContain('getSelfMutes');
    expect(mutes).not.toContain('版本');
  });
});

describe('tool-onebot 专属历史工具开关', () => {
  it('sessionHistory.enabled=false：专属历史工具不注册，其它工具照常', async () => {
    const { app, host, onebotTools } = await setup();
    host.provide.use(platform, adapter('onebot'));
    await app.plugin(toolOnebot, { sessionHistory: { enabled: false } });
    await app.start();
    await app.plugins.idle();
    expect(onebotTools()).toContain('onebot_group_ban');
    expect(onebotTools()).not.toContain('onebot_get_session_history');
    expect(onebotTools()).not.toContain('onebot_resolve_session_id');
  });
});

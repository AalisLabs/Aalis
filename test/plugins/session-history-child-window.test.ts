import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionHistory } from '../../packages/api-session-history/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, optional, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolOnebot from '../../packages/plugin-tool-onebot/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import { type ConfigSchema, deepMergeDefaults, defaultsFrom } from '../../packages/schema-config/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 子会话没有窗口，它的 id 不是哪个平台的窗口 id：平台的历史访问规则按调用所在的窗口判，子会话取根会话的，与出生平台
// 取根会话的是同一条规则。否则子任务里读历史时规则认不出当前窗口，按跨平台调用放行，群里开的子任务就能读私聊。
// 范围粗筛仍按子会话本身判。会话表里预置已收录的房间，子会话经真实的会话管理建出。
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const GROUP = `onebot:${SELF}:group:20001`;
const OTHER_GROUP = `onebot:${SELF}:group:20002`;
const PRIVATE = `onebot:${SELF}:private:30001`;
const OTHER_PRIVATE = `onebot:${SELF}:private:30002`;
const schema = toolOnebot.configSchema as ConfigSchema;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(onebotConfig: Record<string, unknown> = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, sessionManager, history: optional(sessionHistory) });
  host.provide.use(tools, {
    register: (_t: Omit<RegisteredTool, 'pluginName'>) => () => {},
    registerGroup: () => () => {},
  } as never);
  const rooms = [GROUP, OTHER_GROUP, PRIVATE, OTHER_PRIVATE];
  host.provide.use(memory, fakeMemory(Object.fromEntries(rooms.map(id => [id, storedRoom(id)]))) as never);
  await app.pluginAll([
    { definition: sessionManagerPlugin, config: {} },
    { definition: sessionTools, config: {} },
    { definition: toolOnebot, config: deepMergeDefaults(defaultsFrom(schema), onebotConfig) },
  ]);
  await app.start();
  await app.plugins.idle();
  const sm = host.sessionManager.use;
  return {
    /** 在 parent 下建一个子会话，返回从它里面读 target 的历史的结果 */
    async readFromChild(parent: string, target: string) {
      const child = await sm.createChildSession(parent, { name: '<子任务>' });
      if (!host.history.present) throw new Error('session-history 不在场');
      return host.history.use.getHistory({ sessionId: target }, {
        sessionId: child.id,
        platform: 'onebot',
      } as never);
    },
  };
}

describe('子会话里读历史，平台规则按根会话的窗口判', () => {
  it('群里建的子任务读私聊：与在群里读一样被拒', async () => {
    const t = await setup();
    expect(await t.readFromChild(GROUP, PRIVATE)).toEqual({
      error: expect.stringContaining('不允许从群聊读取私聊历史'),
    });
  });

  it('私聊里建的子任务读别的私聊：与在那个私聊里读一样被拒', async () => {
    const t = await setup();
    expect(await t.readFromChild(PRIVATE, OTHER_PRIVATE)).toEqual({
      error: expect.stringContaining('不允许跨私聊读取其他私聊历史'),
    });
  });

  it('不许跨群时，群里建的子任务读本群放行、读别的群被拒', async () => {
    const t = await setup({ sessionHistory: { allowCrossGroup: false } });
    expect(await t.readFromChild(GROUP, GROUP)).toMatchObject({ ok: true });
    expect(await t.readFromChild(GROUP, OTHER_GROUP)).toEqual({
      error: expect.stringContaining('不允许跨群读取其他群历史'),
    });
  });
});

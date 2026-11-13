import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionHistory } from '../../packages/api-session-history/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, optional, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 子会话没有窗口：取别的会话的规则按根会话判，群里建的子任务读私聊与在群里读一样被拒，读本群（同一棵会话树）放行。
// 会话表里预置已收录的房间，子会话经真实的会话管理建出。
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const GROUP = `onebot:${SELF}:group:20001`;
const PRIVATE = `onebot:${SELF}:private:30001`;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, sessionManager, history: optional(sessionHistory) });
  host.provide.use(tools, {
    register: (_t: Omit<RegisteredTool, 'pluginName'>) => () => {},
    registerGroup: () => () => {},
  } as never);
  host.provide.use(memory, fakeMemory(Object.fromEntries([GROUP, PRIVATE].map(id => [id, storedRoom(id)]))) as never);
  await app.pluginAll([{ definition: sessionManagerPlugin }, { definition: sessionTools }]);
  await app.start();
  await app.plugins.idle();
  const sm = host.sessionManager.use;
  return {
    /** 在 parent 下建一个子会话，返回从它里面读 target 的历史的结果 */
    async readFromChild(parent: string, target: string) {
      const child = await sm.createChildSession(parent, { name: '<子任务>' });
      if (!host.history.present) throw new Error('session-history 不在场');
      return host.history.use.getHistory(
        { sessionId: target },
        toolContext({ sessionId: child.id, platform: 'onebot' }),
      );
    },
  };
}

describe('子会话里读历史按根会话判', () => {
  it('群里建的子任务读私聊：与在群里读一样被拒', async () => {
    const t = await setup();
    expect(await t.readFromChild(GROUP, PRIVATE)).toEqual({ error: expect.stringContaining('别人的私聊') });
  });

  it('群里建的子任务读本群：同一棵会话树，放行', async () => {
    const t = await setup();
    expect(await t.readFromChild(GROUP, GROUP)).toMatchObject({ ok: true, sessionId: GROUP });
  });
});

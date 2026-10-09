import { afterEach, describe, expect, it, vi } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// 终端的会话由 plugin-cli 在发出入站之前建档，创建来源写它登记的审批面名 cli：与 WebUI 新建的会话一样是
// owner 的会话，入站时会话表里已有记录，房间收录不会把它当成 IM 房间。会话被删后下一条消息照样补建，
// 已有的记录不改。起真 TUI（假 TTY），按键输入发消息。
// ════════════════════════════════════════════════════════════

const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(stored: Record<string, Record<string, unknown>> = {}) {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  cleanups.push(fakeTty(30, 100).restore);
  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events, sessionManager });
  host.provide(memory, fakeMemory(stored) as never);
  await app.plugin(sessionManagerPlugin);
  await app.plugin(cliPlugin, { startupView: 'chat' });
  await app.plugins.idle();
  for (const name of [sessionManagerPlugin.name, cliPlugin.name]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  await app.start();
  await settle();
  const sm = host.sessionManager.require();
  /** 每条入站发出时会话表里这个会话的样子，与入站的正文（按发出的先后） */
  const seen: Array<SessionInfo | undefined> = [];
  const sent: string[] = [];
  host.events.on('inbound:message', msg => {
    seen.push(structuredClone(sm.getSession(msg.sessionId)));
    sent.push(msg.content);
  });
  /** 打一行字再回车：按键同步派发，与粘贴进来的一样 */
  const enterLine = (text: string) => {
    for (const ch of text) process.stdin.emit('keypress', ch, { name: ch, sequence: ch });
    process.stdin.emit('keypress', '\r', { name: 'return' });
  };
  const say = async (text: string) => {
    enterLine(text);
    await settle();
  };
  return { sm, seen, sent, enterLine, say };
}

describe('终端的会话在入站之前建档', () => {
  it('第一条消息发出时会话已建好，创建来源为 cli，没有来源字段', async () => {
    const { sm, seen, say } = await setup();
    expect(sm.getSession('cli-default')).toBeUndefined();

    await say('你好');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: 'cli-default', createdFrom: 'cli' });
    expect(seen[0]?.originPlatform).toBeUndefined();
    expect(seen[0]?.originChat).toBeUndefined();
  });

  it('会话缺档时一次粘贴两行：建档期间后一行不越过前一行，入站按输入的先后发出', async () => {
    const { sent, enterLine } = await setup();

    enterLine('<第一行>');
    enterLine('<第二行>');
    await settle();

    expect(sent).toEqual(['<第一行>', '<第二行>']);
  });

  it('会话被删后，下一条消息照样补建', async () => {
    const { sm, seen, say } = await setup();
    await say('第一条');
    await sm.deleteSession('cli-default');

    await say('第二条');

    expect(seen[1]).toMatchObject({ id: 'cli-default', createdFrom: 'cli' });
  });

  it('已有的记录不改：没有创建来源的旧记录照旧，名字与更新时间不动', async () => {
    const { sm, seen, say } = await setup({
      'cli-default': {
        id: 'cli-default',
        name: '<旧名>',
        children: [],
        status: 'completed',
        config: {},
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await say('你好');

    expect(seen[0]).toMatchObject({ name: '<旧名>', updatedAt: 1 });
    expect(sm.getSession('cli-default')?.createdFrom).toBeUndefined();
  });
});

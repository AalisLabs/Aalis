import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import {
  type SessionTreeNode,
  type SessionTreeSection,
  sessionListSection,
  sessionManager,
} from '../../packages/api-session-manager/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 会话列表分区：页面动作 getSessionTree 回分好区的结果（我的会话在前、IM 房间在后，空区不回），
// 分区按受众判定、在服务端做；子会话挂在各自父节点下，不作为任何区的根。
// listSessions 照旧含 IM 房间（聊天面板靠它判断是不是新对话）。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const actions = new Map<string, WebuiActionHandler>();
  const host = app.bind({ provide, events, hooks, sessionManager });
  host.provide(memory, fakeMemory() as never);
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction(method: string, handler: WebuiActionHandler) {
      actions.set(method, handler);
      return () => void actions.delete(method);
    },
  } as never);
  await app.plugin(sessionManagerPlugin, {});
  await app.plugins.idle();
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  const sm = host.sessionManager.require();
  const call = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => {
    const handler = actions.get(method);
    if (!handler) throw new Error(`页面动作 ${method} 未登记`);
    return (await handler(args)) as T;
  };
  return { sm, host, call };
}

/** 节点摊成「id → 子节点 id」，比较时不受同区内按更新时间排序的影响 */
const shape = (nodes: SessionTreeNode[]) =>
  Object.fromEntries(nodes.map(n => [n.session.id, n.children.map(c => c.session.id)]));

/** WebUI 根会话带一个子会话、cli-default、经 ensureSession 登记的群房间带一个子任务、经入站登记的私聊房间 */
async function seed(ctx: Awaited<ReturnType<typeof setup>>) {
  const { sm, host } = ctx;
  const webui = await sm.createSession({ name: '<WebUI 会话>' });
  const webuiChild = await sm.createChildSession(webui.id, { name: '<子会话>' });
  await sm.ensureSession('cli-default');
  // /session.set 的落点
  await sm.ensureSession(GROUP, { name: '<群名>' });
  const task = await sm.createChildSession(GROUP, { name: '<子任务>' });
  await host.events.emit('inbound:message', {
    content: '<占位>',
    sessionId: PRIVATE,
    platform: 'onebot',
    sessionType: 'private',
    nickname: '<乙>',
  });
  return { webui, webuiChild, task };
}

describe('getSessionTree 回分好区的结果', () => {
  it('我的会话在前、IM 房间在后，各区的根与挂在下面的子会话都对', async () => {
    const ctx = await setup();
    const { webui, webuiChild, task } = await seed(ctx);

    const sections = await ctx.call<SessionTreeSection[]>('getSessionTree');

    expect(sections.map(s => [s.key, s.label])).toEqual([
      ['owner', '我的会话'],
      ['rooms', 'IM 房间'],
    ]);
    expect(shape(sections[0].nodes)).toEqual({ [webui.id]: [webuiChild.id], 'cli-default': [] });
    expect(shape(sections[1].nodes)).toEqual({ [GROUP]: [task.id], [PRIVATE]: [] });
  });

  it('子会话不作为任何区的根', async () => {
    const ctx = await setup();
    const { webuiChild, task } = await seed(ctx);

    const sections = await ctx.call<SessionTreeSection[]>('getSessionTree');
    const roots = sections.flatMap(s => s.nodes.map(n => n.session.id));

    expect(roots).toHaveLength(4);
    expect(roots).not.toContain(webuiChild.id);
    expect(roots).not.toContain(task.id);
  });

  it('空区不回：没有会话时为空数组，只有 owner 面会话时只回「我的会话」', async () => {
    const ctx = await setup();
    expect(await ctx.call<SessionTreeSection[]>('getSessionTree')).toEqual([]);

    await ctx.sm.ensureSession('cli-default');
    const sections = await ctx.call<SessionTreeSection[]>('getSessionTree');
    expect(sections.map(s => s.key)).toEqual(['owner']);
  });

  it('listSessions 照旧含 IM 房间（回归）', async () => {
    const ctx = await setup();
    await seed(ctx);

    const list = await ctx.call<Array<{ id: string; audience?: string }>>('listSessions');

    expect(list.find(s => s.id === GROUP)?.audience).toBe('group');
    expect(list.find(s => s.id === PRIVATE)?.audience).toBe('private');
  });
});

describe('sessionListSection', () => {
  it('private、group 为 IM 房间，owner 与缺省（子会话）为我的会话', () => {
    expect(sessionListSection({ audience: 'owner' })).toBe('owner');
    expect(sessionListSection({ audience: 'private' })).toBe('rooms');
    expect(sessionListSection({ audience: 'group' })).toBe('rooms');
    expect(sessionListSection({})).toBe('owner');
  });
});

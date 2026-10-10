import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import type { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import maimaiPlugin from '../../packages/plugin-maimai/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// /maimai 的帮助由指令系统生成：裸敲 /maimai 回的就是 /help maimai，查询目标与条数是带说明的位置参数，
// 不再手写一份帮助、也不把用法写进描述。recent 的条数跟在任何一种查询目标后面都生效。
// 失败回复写出了什么事与怎么办：查分器不认凭据写去改 developerToken，连不上写稍后再试；
// 绑定与解绑分开写「没有记忆后端」与「认不出发消息的人」两种原因。没有 memory 插件，记忆后端即缺席。
// 没绑定时按调用者的 QQ 号查只在一对一的聊天窗口里：按会话管理记下的字段判（子会话取根会话的），不看会话 id 的写法。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.stop();
});

/** sessionId 是指令所在的会话；sessions 是会话管理里的记录（只用 getSession），不给时不装会话管理 */
async function setup(sessionId = 'onebot:10000:group:20001', sessions?: SessionInfo[]) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, commands: commandsService });
  host.provide.use(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  if (sessions) {
    const table = new Map(sessions.map(s => [s.id, s]));
    host.provide.use(sessionManager, { getSession: (id: string) => table.get(id) } as never);
  }
  await app.plugin(commandsPlugin, {});
  await app.plugin(maimaiPlugin, { developerToken: 'tok', enableTools: false });
  await app.plugins.idle();
  const registry = host.commands.use as unknown as CommandRegistry;
  /** anonymous：会话认不出发消息的人（没有 userId） */
  return async (line: string, anonymous = false): Promise<string> => {
    const parsed = registry.parseCommand(line);
    if (!parsed) throw new Error(`不是指令: ${line}`);
    const out = await registry.execute(parsed.name, {
      sessionId,
      platform: 'onebot',
      userId: anonymous ? undefined : '30001',
      args: parsed.args,
      raw: parsed.raw,
    });
    return String(out);
  };
}

describe('/maimai 的帮助', () => {
  it('裸敲 /maimai 回的就是 /help maimai：列出子指令', async () => {
    const run = await setup();
    const help = await run('/help maimai');
    expect(await run('/maimai')).toBe(help);
    expect(help.split('\n')[0]).toBe('/maimai — 舞萌 DX 查分。绑定好友码后，info、b50、recent 可以不写查询目标');
    for (const line of [
      '- /maimai b50 — 查询 Best 50',
      '- /maimai bind — 绑定你的好友码',
      '- /maimai info — 查询玩家信息',
      '- /maimai recent — 查询最近游玩',
      '- /maimai song — 搜索曲目',
      '- /maimai unbind — 解绑你的好友码',
    ]) {
      expect(help).toContain(line);
    }
  });

  it('查询目标与条数是带说明的位置参数', async () => {
    const run = await setup();
    expect(await run('/help maimai recent')).toBe(
      [
        '/maimai recent — 查询最近游玩',
        '',
        '用法：/maimai recent [target] [count]',
        '',
        '参数：',
        '- [target]：好友码，或 qq:QQ 号；不写时查你绑定的好友码，OneBot 私聊里没绑定时按你的 QQ 号查',
        '- [count]：显示几条，默认 10，最多 50',
      ].join('\n'),
    );
  });
});

describe('/maimai recent 的条数', () => {
  it('跟在 qq: 目标后面也生效', async () => {
    const recents = Array.from({ length: 12 }, (_, i) => ({
      id: i,
      level_index: 3,
      achievements: 100,
      dx_score: 0,
      type: 'dx',
      play_time: `2026-10-0${(i % 9) + 1}`,
    }));
    vi.stubGlobal('fetch', (async (url: string) => {
      const data = url.includes('/player/qq/123') ? { name: 'p', rating: 1, friend_code: 456 } : recents;
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    }) as unknown as typeof fetch);
    const run = await setup();
    expect(await run('/maimai recent qq:123 5')).toContain('最近 5 条游玩记录');
    expect(await run('/maimai recent qq:123')).toContain('最近 10 条游玩记录');
  });
});

describe('/maimai 的失败回复', () => {
  it('查分器不认开发者凭据（401、403）：写明去改 developerToken', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal(
        'fetch',
        (async () =>
          new Response(JSON.stringify({ success: false, message: 'invalid token' }), {
            status,
          })) as unknown as typeof fetch,
      );
      const run = await setup();
      expect(await run('/maimai info 123')).toBe(
        `查询失败: 查分器不认开发者凭据：检查配置项 developerToken（HTTP ${status}：invalid token）`,
      );
    }
  });

  it('查分器连不上：写明稍后再试，带出底层原因', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
    }) as unknown as typeof fetch);
    const run = await setup();
    expect(await run('/maimai b50 123')).toBe(
      '查询失败: 查分器暂时连不上，稍后再试（connect ECONNREFUSED 127.0.0.1:9）',
    );
  });

  it('查分器回复别的错误：照它的话说', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(JSON.stringify({ success: false, message: '玩家不存在' }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    const run = await setup();
    expect(await run('/maimai recent 123')).toBe('查询失败: 查分器回复：玩家不存在');
  });

  it('没有记忆后端：绑定与解绑写明要启用一个记忆后端', async () => {
    const run = await setup();
    const fix =
      '没有在运行的记忆后端（绑定记在它里面）：在 WebUI 插件区启用一个（如 SQLite 记忆），' +
      '或把它从配置文件的 disabledPlugins 里删掉；启用了还起不来就用 /doctor 看原因';
    expect(await run('/maimai bind 123456')).toBe(`绑定失败：${fix}`);
    expect(await run('/maimai unbind')).toBe(`解绑失败：${fix}`);
  });

  it('认不出发消息的人：绑定与解绑写明要在能认出发送者的平台上做', async () => {
    const run = await setup();
    const fix = '认不出发消息的人（没有平台用户 id），绑定只能在认得出发送者的平台上做，如 QQ';
    expect(await run('/maimai bind 123456', true)).toBe(`绑定失败：${fix}`);
    expect(await run('/maimai unbind', true)).toBe(`解绑失败：${fix}`);
  });
});

describe('/maimai 没绑定时按调用者的 QQ 号查', () => {
  const GROUP = 'onebot:10000:group:20001';
  const PRIVATE = 'onebot:10000:private:30001';
  const TASK = `${PRIVATE}::abcd1234`;
  const sessions = [
    storedRoom(GROUP),
    storedRoom(PRIVATE),
    {
      id: TASK,
      name: TASK,
      children: [],
      status: 'waiting',
      config: {},
      createdAt: 0,
      updatedAt: 0,
      parentId: PRIVATE,
    },
  ] as unknown as SessionInfo[];
  const BY_QQ = '使用你的 QQ 号查询查分器';
  const NONE = '未找到查询目标';

  it.each([
    ['一对一的聊天窗口', PRIVATE, BY_QQ],
    ['一对一窗口里的子会话（取根会话的）', TASK, BY_QQ],
    ['多方的聊天窗口', GROUP, NONE],
    ['会话表里没有记录的会话（id 写着 private 也不算）', 'onebot:10000:private:30002', NONE],
  ])('%s', async (_label, sessionId, expected) => {
    const player = { name: 'p', rating: 1, friend_code: 456 };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true, data: player }), { status: 200 }));
    const run = await setup(sessionId, sessions);
    expect(await run('/maimai info')).toContain(expected);
  });
});

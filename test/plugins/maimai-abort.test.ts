import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import type { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import maimaiPlugin from '../../packages/plugin-maimai/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { provideEvents, registerHubs } from '../fixtures/hubs.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 查分器请求接中止信号，与 timeoutMs 谁先到按谁停：工具接这次调用的（回合中止时停下），指令的契约不带信号，接本插件
// 这次激活的（停用、停机时停下）。中止时以中止原因收尾，不按「查分器暂时连不上」回。查分器是替身：只在中止时拒绝，记下
// 每次请求收到的信号。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.stop();
});

/** 查分器一直不回，中止时以中止原因拒绝；返回每次请求收到的信号 */
function hangingApi(): AbortSignal[] {
  const sent: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<never>((_, reject) => {
          const signal = init.signal as AbortSignal;
          sent.push(signal);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    ),
  );
  return sent;
}

/** 只开工具的 maimai，返回工具注册表 */
async function bootTools() {
  const app = new App({ name: 'T', logLevel: 'error' });
  provideEvents(app);
  apps.push(app);
  await app.plugins.register(toolsPlugin, {});
  await app.plugins.register(maimaiPlugin, { developerToken: 'tok', enableCommands: false });
  await app.plugins.idle();
  const registry = app.bind({ services }).services.use.get(tools);
  if (!registry) throw new Error('没有工具注册表');
  return registry;
}

describe('maimai 查询随中止停下', () => {
  it.each([
    ['maimai_get_player_info', { friend_code: '123' }],
    ['maimai_get_b50', { friend_code: '123' }],
    ['maimai_get_recents', { friend_code: '123' }],
    ['maimai_search_song', { keyword: '<曲名>' }],
  ])('工具 %s 请求途中中止：交给 fetch 的信号随之断开，不按连不上回', async (name, args) => {
    const sent = hangingApi();
    const registry = await bootTools();
    const ac = new AbortController();
    const pending = registry.execute(name, args, toolRequest({ sessionId: 's1', signal: ac.signal }));
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    ac.abort();
    expect(sent.every(signal => signal.aborted)).toBe(true);
    expect((await pending).content).not.toContain('连不上');
  });

  it('指令途中停用：交给 fetch 的信号随之断开，不按连不上回', async () => {
    const sent = hangingApi();
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, commands: commandsService });
    host.provide.use(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
    await app.plugin(commandsPlugin, {});
    await app.plugin(maimaiPlugin, { developerToken: 'tok', enableTools: false });
    await app.plugins.idle();
    const registry = host.commands.use as unknown as CommandRegistry;
    const parsed = registry.parseCommand('/maimai info 123');
    if (!parsed) throw new Error('不是指令');
    const pending = registry.execute(parsed.name, {
      sessionId: 'onebot:10000:group:20001',
      platform: 'onebot',
      userId: '30001',
      args: parsed.args,
      raw: parsed.raw,
    });
    await expect.poll(() => sent.length).toBe(1);
    await app.plugins.disable(maimaiPlugin.name);
    expect(sent[0].aborted).toBe(true);
    expect(String(await pending)).not.toContain('连不上');
  });

  it('曲库的别名请求途中中止：不把缺了别名的曲库缓存下来，下次照常按别名搜到', async () => {
    const song = { id: 1, title: '<曲名>', artist: '<作者>', genre: '<分类>', bpm: 120, version: 1 };
    let aliasCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown, init: RequestInit) => {
        if (String(url).includes('/song/list'))
          return Promise.resolve(Response.json({ success: true, data: { songs: [song] } }));
        aliasCalls++;
        if (aliasCalls > 1) {
          return Promise.resolve(
            Response.json({ success: true, data: { aliases: [{ song_id: 1, aliases: ['<别名>'] }] } }),
          );
        }
        const signal = init.signal as AbortSignal;
        return new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }),
    );
    const registry = await bootTools();
    const ac = new AbortController();
    const first = registry.execute(
      'maimai_search_song',
      { keyword: '<别名>' },
      toolRequest({ sessionId: 's1', signal: ac.signal }),
    );
    await expect.poll(() => aliasCalls).toBe(1);
    ac.abort();
    await first;
    const again = await registry.execute('maimai_search_song', { keyword: '<别名>' }, toolRequest({ sessionId: 's1' }));
    expect(again.content).toContain('<曲名>');
  });
});

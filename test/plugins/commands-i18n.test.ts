import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { commands } from '../../packages/api-commands/src/index.js';
import { gateway, INBOUND_PHASE } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type I18nService, i18n } from '../../packages/api-i18n/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type SessionItem, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type App, events, type Logger, provide } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import { defineTexts, type Localized } from '../../packages/schema-i18n/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { seedRooms } from '../fixtures/rooms.js';
import { client } from '../fixtures/session-client.js';

// ════════════════════════════════════════════════════════════
// 聊天出站按会话的语言：处理函数交出的文字对象由 plugin-commands 原样交给网关（content 是原文），网关按这条消息所在会话
// （{ sessionId, platform }，房间按会话设置 language，owner 会话按全局默认层）的语言渲染进 content，再交给平台；WebUI 会话里
// 由会话服务按全局默认层的语言渲染。指令系统自己的句子（解析报错、/help 的版式）与网关的兜底回复进各自的字典；/help 按会话的语言渲染说明之后再取
// 摘要，回复是这种语言的字符串。CommandService.execute 按执行输入的 { sessionId, platform } 渲染。i18n 渲染抛错时各出口按原文
// 发出，各自告警一次。
// 真的 plugin-i18n、plugin-commands、plugin-gateway、会话管理与会话服务，记忆是内存实现，存储与 owner 判定是替身。
// ════════════════════════════════════════════════════════════

const NS = '@zz/commands-i18n';
const t = defineTexts({
  ns: NS,
  language: 'zh-CN',
  source: {
    hello: '你好，{name}',
    helloDescription: '打个招呼。回一句问候',
    longDescription: '一句很长的说明。后面是细节',
  } as const,
  locales: {
    en: {
      hello: 'Hello, {name}',
      helloDescription: 'Say hello. Replies with a greeting',
      longDescription: 'Explains at great length what this command does and more. Details',
    },
  },
});

/** 聊天平台：适配器收 outbound:message 里这个平台的消息 */
const CHAT = 'zz-chat';
/** 预置在会话表里的聊天平台房间：经网关的原生入站会跑完整条相位链（兜底回复也是出站），不经它收录 */
const ROOMS = [1, 2, 3].map(n => `${CHAT}:bot:group:${n}`);
const OWNER = { platform: 'webui', userId: 'console' };

/** render 与 chainOf 都抛它的 i18n 替身 */
const BROKEN = new Error('<i18n 坏了>');
const broken: I18nService = {
  render: () => {
    throw BROKEN;
  },
  chainOf: () => {
    throw BROKEN;
  },
  languages: () => [],
};

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * withI18n 为假时没有 i18n 服务，i18nService 给了就用这个替身代替 plugin-i18n；stubGateway 为真时网关是替身：入站只跑指令
 * 相位，出站原样发出、不渲染（与 plugin-commands 在网关缺席时直接发出的是同一条消息）；defaults 是全局默认层的语言
 */
async function setup({
  withI18n = true,
  i18nService,
  stubGateway = false,
  defaults,
}: {
  withI18n?: boolean;
  i18nService?: I18nService;
  stubGateway?: boolean;
  defaults?: string[];
} = {}) {
  const warn = vi.fn();
  const logger: Logger = { debug() {}, info() {}, warn, error() {}, child: () => logger };
  const { app } = hostedApp(defaults ? { sessionConfig: { defaults: { language: defaults } } } : {}, { logger });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-commands-i18n-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, commands, gateway, sessionManager, sessionProtocol });
  host.provide.use(storage, memoryStorage(new Map()));
  if (i18nService) host.provide.use(i18n, i18nService);
  host.provide.use(authority, {
    isOwner: (p: string, u?: string) => p === OWNER.platform && u === OWNER.userId,
    authorize: () => null,
  } as never);
  if (stubGateway) {
    host.provide.use(gateway, {
      ingressMessage: async message => {
        await host.hooks.use.run(INBOUND_PHASE.COMMAND, { message, metadata: {}, agent: undefined });
      },
      dispatchOutbound: async message => {
        await host.events.use.emit('outbound:message', message);
      },
    });
  }
  // 房间要在会话管理读表之前预置进记忆后端
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  await seedRooms(app.bind({ memory }).memory.use, Object.fromEntries(ROOMS.map(id => [id, id])));
  const plugins = [
    sessionManagerPlugin,
    ...(stubGateway ? [] : [gatewayPlugin]),
    commandsPlugin,
    sessionServerPlugin,
    ...(withI18n && !i18nService ? [i18nPlugin] : []),
  ];
  // 与 runtime 一样一批登记
  await app.pluginAll(plugins.map(definition => ({ definition, config: {} })));
  await app.plugins.idle();
  for (const { name } of [memoryInMemory, ...plugins]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  host.commands.use.command('zz-hello', t('helloDescription')).action(() => t('hello', { name: 'zz' }));
  host.commands.use.command('zz-long', t('longDescription')).action(() => 'ok');
  host.commands.use.command('zz-count <n:number>', '计数').action((_argv, n) => String(n));
  // 内置指令随 plugin-commands 激活登记，等它们出现
  await vi.waitFor(() => expect(host.commands.use.get('clear')).toBeDefined());

  const sent: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', message => {
    if (message.platform === CHAT) sent.push(message);
  });
  /** 在聊天平台的会话里说一句，取这一句引出的第一条出站（要确认的指令在得到回复之前一直在处理，不等入站处理完） */
  const ask = async (sessionId: string, content: string): Promise<OutgoingMessage> => {
    const before = sent.length;
    void host.gateway.use.ingressMessage({ content, sessionId, platform: CHAT, userId: 'zz-user' });
    await vi.waitFor(() => expect(sent.length).toBe(before + 1));
    return sent[before];
  };
  let rooms = 0;
  /** 下一个预置的房间；language 是它自己的会话设置 */
  const session = async (language?: string[]) => {
    const id = ROOMS[rooms++];
    if (language) await host.sessionManager.use.updateSession(id, { config: { language } });
    return id;
  };
  const connect = async () => {
    const c = client(host.sessionProtocol.use);
    await c.init();
    return c;
  };
  /** 告警里带着 i18n 抛出的那个错的 */
  const renderWarnings = () => warn.mock.calls.filter(call => call.includes(BROKEN));
  return { host, ask, session, connect, renderWarnings };
}

/** 时间线里通知的文字 */
const notices = (items: Localized<SessionItem>[]) => items.flatMap(item => (item.kind === 'notice' ? [item.text] : []));

describe('指令回复按会话的语言', () => {
  it('处理函数交出文字对象：en 会话的平台收到英文，zh-CN 会话收到原文', async () => {
    const s = await setup();
    expect((await s.ask(await s.session(['en']), '/zz-hello')).content).toBe('Hello, zz');
    expect((await s.ask(await s.session(['zh-CN']), '/zz-hello')).content).toBe('你好，zz');
  });

  it('owner 会话一律按全局默认层：WebUI 建的会话自己存着 en 也按 zh-CN，房间自己设的 en 照旧生效', async () => {
    const s = await setup({ defaults: ['zh-CN'] });
    const owner = await s.host.sessionManager.use.createSession(
      { config: { language: ['en'] } },
      { createdFrom: 'webui' },
    );
    expect(owner.kind).toBe('owner');
    const run = (sessionId: string, platform: string) =>
      s.host.commands.use.execute('zz-hello', { sessionId, platform, args: [], raw: '/zz-hello' });
    expect(await run(owner.id, OWNER.platform)).toBe('你好，zz');
    expect(await run(await s.session(['en']), CHAT)).toBe('Hello, zz');
  });

  it('i18n 缺席：原文', async () => {
    const s = await setup({ withI18n: false });
    expect((await s.ask(await s.session(), '/zz-hello')).content).toBe('你好，zz');
  });

  it('网关不渲染时（网关缺席时直接发出的同一条消息）：content 是原文，文字对象随消息交出', async () => {
    const s = await setup({ stubGateway: true });
    const out = await s.ask(await s.session(['en']), '/zz-hello');
    expect(out.content).toBe('你好，zz');
    expect(out.text).toMatchObject({ i18n: NS, key: 'hello', params: { name: 'zz' } });
  });

  it('回复发往 WebUI 会话：连接按全局默认层的语言看到通知（没设时按 en）', async () => {
    const s = await setup();
    const c = await s.connect();
    const { session } = await c.call('session/create', {});
    const base = await c.subscribe(session.id);
    await s.host.gateway.use.ingressMessage({ content: '/zz-hello', sessionId: session.id, ...OWNER });
    await vi.waitFor(() => expect(notices(c.timeline(session.id, base))).toEqual(['Hello, zz']));
  });

  it('解析报错按会话的语言', async () => {
    const s = await setup();
    expect((await s.ask(await s.session(['en']), '/zz-count abc')).content).toBe(
      'Argument n needs a number, got “abc”',
    );
    expect((await s.ask(await s.session(['zh-CN']), '/zz-count abc')).content).toBe('参数 n 需要数字，收到「abc」');
  });

  it('/help 按会话的语言渲染好再交出（不带文字对象）：概览的摘要取英文说明的第一句，过长的按 48 列截断', async () => {
    const s = await setup();
    const out = await s.ask(await s.session(['en']), '/help');
    expect(out.text).toBeUndefined();
    const lines = out.content.split('\n');
    expect(lines[0]).toMatch(/^Available commands \(\d+\):$/);
    expect(lines).toContain('- /zz-hello — Say hello');
    expect(lines).toContain('- /zz-long — Explains at great length what this command does…');
    expect(lines.at(-1)).toBe('Details: /help followed by a command name, or add -h after a command');
  });

  it('CommandService.execute 交出按 { sessionId, platform } 渲染好的字符串', async () => {
    const s = await setup();
    const run = async (sessionId: string) =>
      s.host.commands.use.execute('zz-hello', { sessionId, platform: CHAT, args: [], raw: '/zz-hello' });
    expect(await run(await s.session(['en']))).toBe('Hello, zz');
    expect(await run(await s.session(['zh-CN']))).toBe('你好，zz');
  });

  it('网关自己的兜底回复（没有 agent）按会话的语言', async () => {
    const s = await setup();
    expect((await s.ask(await s.session(['en']), '在吗')).content).toBe(
      '[System] The agent service is unavailable; check the plugin configuration.',
    );
  });
});

describe('内置指令的说明与回复按会话的语言', () => {
  it('en 会话的 /help 概览里，内置指令的摘要是英文', async () => {
    const s = await setup();
    const lines = (await s.ask(await s.session(['en']), '/help')).content.split('\n');
    expect(lines).toContain('- /status — Shows the system status');
    expect(lines).toContain('- /clear — Clears the memory of this session · 1 subcommand');
    expect(lines).toContain('- /restart — Restarts the application');
  });

  it('en 会话里 /clear -t 给了不认识的类型：报错是英文', async () => {
    const s = await setup();
    s.host.commands.use.setExecutionGuard(async () => null);
    expect((await s.ask(await s.session(['en']), '/clear -t bogus')).content).toBe(
      'Unknown clear type: bogus. Available types: all, context, summary, vector, image, video, audio, file, persona, ' +
        'checkpoint, user-profile, user-relation. See /help clear',
    );
  });

  it('en 会话里 /clear 的结果是英文：消息历史与附件缓存的结果行', async () => {
    const s = await setup();
    s.host.commands.use.setExecutionGuard(async () => null);
    expect((await s.ask(await s.session(['en']), '/clear -t context,image')).content).toBe(
      ['✅ No image cache in this session', "✅ This session's message history cleared"].join('\n'),
    );
  });

  it('en 会话里意图确认的问句是英文', async () => {
    const s = await setup();
    s.host.commands.use.setExecutionGuard(async ({ confirmIntent }) =>
      confirmIntent && !(await confirmIntent()) ? 'cancelled' : null,
    );
    s.host.commands.use.command('zz-probe', '探针', { confirm: 'session' }).action(() => 'ran');
    const sessionId = await s.session(['en']);
    expect((await s.ask(sessionId, '/zz-probe')).content).toBe(
      'Run /zz-probe? Reply y to confirm, anything else to cancel; no reply within 60 seconds also cancels.',
    );
    expect((await s.ask(sessionId, 'n')).content).toBe('cancelled');
  });
});

describe('i18n 渲染抛错：按原文发出，各出口告警一次', () => {
  it('带文字对象回复的指令：平台收到原文，网关告警一次', async () => {
    const s = await setup({ i18nService: broken });
    const sessionId = await s.session();
    expect((await s.ask(sessionId, '/zz-hello')).content).toBe('你好，zz');
    expect((await s.ask(sessionId, '/zz-hello')).content).toBe('你好，zz');
    expect(s.renderWarnings()).toHaveLength(1);
  });

  it('execute 交出原文，/help 照常回复原文；指令系统告警一次', async () => {
    const s = await setup({ i18nService: broken });
    const sessionId = await s.session();
    expect(
      await s.host.commands.use.execute('zz-hello', { sessionId, platform: CHAT, args: [], raw: '/zz-hello' }),
    ).toBe('你好，zz');
    const lines = (await s.ask(sessionId, '/help')).content.split('\n');
    expect(lines[0]).toMatch(/^可用指令（\d+ 条）：$/);
    expect(lines).toContain('- /zz-hello — 打个招呼');
    expect(s.renderWarnings()).toHaveLength(1);
  });
});

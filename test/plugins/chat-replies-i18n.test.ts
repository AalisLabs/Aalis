import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { commands } from '../../packages/api-commands/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type SessionInfo, sessionLabel, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, type Logger, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import doctorPlugin from '../../packages/plugin-doctor/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { defineTexts, localize, resolveText, TextError } from '../../packages/schema-i18n/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { createMockLLMPlugin, MockLLMService } from '../fixtures/mock-llm.js';
import { storedRoom } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 第一方发到聊天里的固定文字按会话的语言：/doctor 的报告版式、/session 的版式（设置项的称呼、层名、默认会话名、默认工作区
// 随读者），agent 发出的「[系统]」「[错误]」两句，/model 与 /persona 的分页回复。它们交出文字对象，网关按消息所在房间（会话设置 language）的语言渲染；
// i18n 缺席时是原文。房间是 owner 在聊天平台上的私聊（场所是默认工作区）。真的 plugin-i18n、plugin-commands、plugin-gateway、
// plugin-agent、plugin-doctor、会话管理与会话设置，记忆是内存实现，存储与 owner 判定是替身。
// ════════════════════════════════════════════════════════════

const t = defineTexts({
  ns: '@zz/chat-replies-i18n',
  language: 'zh-CN',
  source: { boom: '模型炸了' } as const,
  locales: { en: { boom: 'The model blew up' } },
});

/** 聊天平台：适配器收 outbound:message 里这个平台的消息 */
const CHAT = 'zz-chat';
const OWNER = 'zz-owner';
/**
 * 预置在会话表里的房间：owner 经几个机器人账号的私聊，没取名。经网关的原生入站会执行整条相位链（兜底回复也是出站），
 * 不经它收录
 */
const ROOMS = [1, 2, 3].map(n => `${CHAT}:bot${n}:private:${OWNER}`);

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** withI18n 为假时没有 i18n 服务；llm 给了就装上这个模型插件，不给时一个模型都没有 */
async function setup({ withI18n = true, llm }: { withI18n?: boolean; llm?: PluginDefinition } = {}) {
  const app = new App({ logLevel: 'error', logger: silent });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-chat-replies-i18n-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({ provide, events, commands, gateway, sessionManager, sessionSettings });
  host.provide.use(storage, memoryStorage(new Map()));
  host.provide.use(authority, {
    isOwner: (platform: string, userId?: string) => platform === CHAT && userId === OWNER,
    authorize: () => null,
    meetsLevel: () => true,
  } as never);
  // 房间要在会话管理读表之前预置进记忆后端
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  await app
    .bind({ memory })
    .memory.use.commitMetadata(
      ROOMS.map(id => ({ op: 'put' as const, namespace: 'sessions', key: id, data: storedRoom(id) })),
    );
  const plugins: Array<{ definition: PluginDefinition; config?: Record<string, unknown> }> = [
    ...(llm ? [{ definition: llm }] : []),
    { definition: messageArchivePlugin, config: { debugLogs: false } },
    { definition: sessionManagerPlugin },
    { definition: sessionSettingsPlugin },
    { definition: gatewayPlugin },
    { definition: commandsPlugin },
    { definition: agentPlugin, config: { systemPrompt: 'test', memoryTokenBudget: 1024 } },
    { definition: doctorPlugin },
    ...(withI18n ? [{ definition: i18nPlugin }] : []),
  ];
  // 与 runtime 一样一批登记
  await app.pluginAll(plugins.map(({ definition, config }) => ({ definition, config: config ?? {} })));
  await app.plugins.idle();
  for (const { definition } of [{ definition: memoryInMemory }, ...plugins]) {
    const state = app.plugins.getPlugin(definition.name)?.state;
    if (state !== 'active') throw new Error(`${definition.name} 未激活（state=${state}）`);
  }
  // 权限插件的执行守卫：一律放行（/doctor 与 /session 是受限指令，没有守卫时拒绝执行）
  host.commands.use.setExecutionGuard(async () => ({ ok: true }));

  const sent: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', message => {
    if (message.platform === CHAT) sent.push(message);
  });
  /** 在聊天平台的会话里说一句，取这一句引出的那条出站的正文，按行拆开 */
  const ask = async (sessionId: string, content: string): Promise<string[]> => {
    const before = sent.length;
    await host.gateway.use.ingressMessage({ content, sessionId, platform: CHAT, userId: OWNER });
    await vi.waitFor(() => expect(sent.length).toBe(before + 1));
    return sent[before].content.split('\n');
  };
  let rooms = 0;
  /** 下一个预置的房间；language 是它自己的会话设置 */
  const session = async (language?: string[]) => {
    const id = ROOMS[rooms++];
    if (language) {
      await host.sessionSettings.use.update(
        { sessionId: id },
        { plugin: i18nPlugin.name, key: 'language', value: language },
      );
    }
    return host.sessionManager.use.getSession(id) as SessionInfo;
  };
  return { host, ask, session };
}

describe('/doctor 的报告按会话的语言', () => {
  it('en 会话是英文版式，zh-CN 会话与 i18n 缺席是原文', async () => {
    const s = await setup();
    const english = await s.ask((await s.session(['en'])).id, '/doctor');
    expect(english[0]).toMatch(/^\*\*System diagnostics — .+\*\*$/);
    expect(english[1]).toMatch(/^Summary: \d+ passed, \d+ warnings?, \d+ errors?$/);
    expect(english).toContain('__Passed__');
    const chinese = /^汇总：通过 \d+　警告 \d+　错误 \d+$/;
    const zh = await s.ask((await s.session(['zh-CN'])).id, '/doctor');
    expect([zh[0].startsWith('**系统诊断 — '), zh[1]]).toEqual([true, expect.stringMatching(chinese)]);
    expect(zh).toContain('__通过__');

    const absent = await setup({ withI18n: false });
    const source = await absent.ask((await absent.session()).id, '/doctor');
    expect([source[0].startsWith('**系统诊断 — '), source[1]]).toEqual([true, expect.stringMatching(chinese)]);
  });
});

describe('/session 按会话的语言', () => {
  /** 默认工作区这个场所设了深度思考：来源写场所的显示名（默认工作区没有名字） */
  const placeThink = (s: Awaited<ReturnType<typeof setup>>) =>
    s.host.sessionSettings.use.update(
      { layer: { scope: 'place', key: 'workspace:default' } },
      { plugin: agentPlugin.name, key: 'think', value: 'deep' },
    );

  /** 没取名的会话的默认名，按这种语言显示 */
  const nameIn = (info: SessionInfo, language: string) =>
    localize(sessionLabel(info), text => resolveText(text, [language]));

  it('en 会话：版式、设置项的称呼、层名、默认会话名与默认工作区都是英文；zh-CN 会话是原文', async () => {
    const s = await setup();
    await placeThink(s);
    const en = await s.session(['en']);
    const english = await s.ask(en.id, '/session');
    expect(english[0]).toBe(`Settings of ${nameIn(en, 'en')}:`);
    expect(english).toContain('Thinking (think): deep — from Place “Default workspace”');
    expect(english).toContain('Language (language): en — from This session');
    const zh = await s.session(['zh-CN']);
    const chinese = await s.ask(zh.id, '/session');
    expect(chinese[0]).toBe(`${nameIn(zh, 'zh-CN')} 的设置：`);
    expect(chinese).toContain('深度思考（think）：deep — 来自 场所「默认工作区」');
  });

  it('i18n 缺席：原文', async () => {
    const s = await setup({ withI18n: false });
    await placeThink(s);
    const info = await s.session();
    const lines = await s.ask(info.id, '/session');
    expect(lines[0]).toBe(`${nameIn(info, 'zh-CN')} 的设置：`);
    expect(lines).toContain('深度思考（think）：deep — 来自 场所「默认工作区」');
  });
});

describe('agent 发到会话里的「[系统]」「[错误]」按会话的语言', () => {
  it('解析不出模型：en 会话里整句是英文；zh-CN 是原文', async () => {
    const s = await setup();
    expect(await s.ask((await s.session(['en'])).id, '在吗')).toEqual([
      '[System] No model with the chat capability was found — make sure at least one model provider plugin ' +
        '(such as @aalis/plugin-llm-deepseek) is installed and enabled.',
    ]);
    expect(await s.ask((await s.session(['zh-CN'])).id, '在吗')).toEqual([
      '[系统] 未找到任何具备 chat 能力的模型 —— 请确认已安装并启用至少一个模型提供者插件（如 @aalis/plugin-llm-deepseek）。',
    ]);
  });

  it('模型调用抛出带文字对象的错：en 会话里整句是英文', async () => {
    const s = await setup({ llm: createMockLLMPlugin({ throwOnce: new TextError(t('boom')) }) });
    expect(await s.ask((await s.session(['en'])).id, '在吗')).toEqual(['[Error] The model blew up']);
  });
});

describe('/model 与 /persona 的分页回复按会话的语言', () => {
  /** 各个回复：首行、行数与末行 */
  const brief = (lines: string[]) => [lines[0], lines.length, lines.at(-1)];
  const REPLIES = {
    en: [
      ['Showing available models (21 in total · page 1/2):', 22, '—— Next page: /model -p 2  Search: /model <keyword>'],
      ['Showing available models (21 in total · page 2/2):', 3, '—— Next page: /model -p 1  Search: /model <keyword>'],
      ['Showing available models containing “zz” (21 in total · page 1/2):', 22, '—— Next page: /model zz -p 2'],
      ['No available models match “zz-none”', 1, 'No available models match “zz-none”'],
      ['(No available personas)', 1, '(No available personas)'],
    ],
    'zh-CN': [
      ['可用模型（共 21 · 第 1/2 页）：', 22, '—— 翻页：/model -p 2　搜索：/model <关键词>'],
      ['可用模型（共 21 · 第 2/2 页）：', 3, '—— 翻页：/model -p 1　搜索：/model <关键词>'],
      ['可用模型（含"zz" 共 21 · 第 1/2 页）：', 22, '—— 翻页：/model zz -p 2'],
      ['无匹配 "zz-none" 的可用模型', 1, '无匹配 "zz-none" 的可用模型'],
      ['（无可用人设）', 1, '（无可用人设）'],
    ],
  };

  it.each(
    Object.entries(REPLIES),
  )('%s 会话：21 个模型分两页，带关键词与没有匹配；没有人设服务', async (language, expected) => {
    const s = await setup();
    for (let i = 1; i <= 21; i++) {
      s.host.provide.use(llm, new MockLLMService(), { entryId: `zz/m${String(i).padStart(2, '0')}` });
    }
    const room = (await s.session([language])).id;
    const replies = [];
    for (const command of ['/model', '/model -p 2', '/model zz', '/model zz-none', '/persona']) {
      replies.push(brief(await s.ask(room, command)));
    }
    expect(replies).toEqual(expected);
  });
});

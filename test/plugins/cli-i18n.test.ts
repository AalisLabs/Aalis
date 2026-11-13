import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApprovalRequest, approvals } from '../../packages/api-approval/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { type I18nService, i18n } from '../../packages/api-i18n/src/index.js';
import { persona } from '../../packages/api-persona/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import en from '../../packages/plugin-cli/src/locales/en.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { defineTexts, TextError } from '../../packages/schema-i18n/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { attachSessionServer } from '../fixtures/cli-session.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { provideEvents, registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { declareToolSystemDisplays } from '../fixtures/tool-display.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// 终端界面是 owner 自己看的，按全局层的语言（{ host: true }，plugin-i18n 的插件配置）显示，不看终端会话自己的语言设置：欢迎行、
// 帮助页、审批卡的标题与按键提示、附件类别、底栏的按键提示取 plugin-cli 的字典；审批的事实是逐字的参数，里面伪造的文字对象原样显示。
// 宿主配置里的语言变了立即重绘；帮助页按终端宽度折行，审批卡上事实的标签补齐到同一宽度（译文长短不一）。
// i18n 缺席或渲染抛错时按原文，抛错只告警一次。送达失败（含只带附件的出站）的原因是挂着文字对象的报错时交出文字对象。
// 真的 plugin-i18n、会话管理与会话设置、会话服务（审批服务）与 TUI（假 TTY，收集 stdout 帧），记忆是内存实现，存储与 owner
// 判定是替身。
// ════════════════════════════════════════════════════════════

const NS = '@zz/cli-i18n';
const t = defineTexts({
  ns: NS,
  language: 'zh-CN',
  source: { forged: '<原文>', failure: '<写不出>' } as const,
  locales: { en: { forged: '<译文>' } },
});

const CONSOLE = { platform: 'cli', userId: 'console' };
const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
/** 等两拍：渲染排在 setImmediate 上 */
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));

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

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/**
 * 全局层的语言是 language；cliLanguage 给了就另设 cli 平台档的语言（终端会话按平台档取到它，界面不看它）。i18n 为
 * absent 时没有 i18n 服务，broken 时由抛错的替身代替 plugin-i18n。终端缺省 40 行 120 列
 */
async function setup({
  language,
  cliLanguage,
  i18nMode = 'plugin',
  rows = 40,
  columns = 120,
}: {
  language: string[];
  cliLanguage?: string[];
  i18nMode?: 'plugin' | 'absent' | 'broken';
  rows?: number;
  columns?: number;
}) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    writes.push(String(chunk));
    return true;
  });
  cleanups.push(fakeTty(rows, columns).restore);
  const warn = vi.fn();
  const logger: Logger = { debug() {}, info() {}, warn, error() {}, child: () => logger };
  const home = mkdtempSync(join(tmpdir(), 'aalis-cli-i18n-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const { app } = hostedApp(
    {
      plugins: { [i18nPlugin.name]: { language } },
      ...(cliLanguage
        ? { sessionConfig: { platforms: { cli: { [i18nPlugin.name]: { language: cliLanguage } } } } }
        : {}),
    },
    { logger },
  );
  cleanups.push(() => app.stop());
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  provideHostPaths(app, home);
  const host = app.bind({ provide, events, approvals, tools, hostConfig });
  host.provide.use(storage, memoryStorage(new Map()));
  // 终端身份是不是 owner：demote 之后不再是，应答被拒
  let consoleIsOwner = true;
  host.provide.use(authority, {
    isOwner: (p: string, u?: string) => consoleIsOwner && p === 'cli' && u === 'console',
  } as never);
  if (i18nMode === 'broken') host.provide.use(i18n, broken);
  await app.plugin(toolsPlugin, {});
  await app.plugins.idle();
  declareToolSystemDisplays(host.tools.use);
  const plugins = [
    sessionManagerPlugin,
    sessionSettingsPlugin,
    sessionServerPlugin,
    ...(i18nMode === 'plugin' ? [i18nPlugin] : []),
    cliPlugin,
  ];
  for (const definition of plugins) await app.plugin(definition, {});
  await app.plugins.idle();
  for (const { name } of plugins) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  await app.start();
  await settle();

  const frame = () => {
    const all = writes.join('');
    return all.slice(all.lastIndexOf(FRAME_SPLIT)).replace(ANSI_RE, '');
  };
  /** 按 Ctrl 加一个键 */
  const ctrl = async (name: string) => {
    process.stdin.emit('keypress', '', { name, ctrl: true });
    await settle();
  };
  /** 打一个字：终端变为在场，审批推到这里 */
  const touch = async () => {
    process.stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
    await settle();
  };
  const request = async (over: Partial<ApprovalRequest> = {}) => {
    void host.approvals.use.request({
      sessionId: 'cli-default',
      origin: { kind: 'hand', participants: [CONSOLE] },
      tool: 'exec',
      args: { command: 'ls' },
      rule: 'tool:exec 声明需确认',
      canAnswer: who => consoleIsOwner && who.platform === 'cli' && who.userId === 'console',
      ownerOnly: true,
      ...over,
    });
    await settle();
  };
  const send = (message: Omit<OutgoingMessage, 'sessionId' | 'platform'>) =>
    host.events.use.emit('outbound:message', { sessionId: 'cli-default', platform: 'cli', ...message });
  /** 带着 i18n 抛出的那个错的告警，取告警的那句话 */
  const renderWarnings = () =>
    warn.mock.calls.filter(call => call.includes(BROKEN)).map(([message]) => String(message));
  /** 改全局层的语言：宿主配置里 plugin-i18n 的配置段 */
  const setLanguage = (language: string[]) => host.hostConfig.use.setPluginConfig(i18nPlugin.name, { language });
  const demote = () => {
    consoleIsOwner = false;
  };
  return { frame, ctrl, touch, request, send, renderWarnings, setLanguage, demote };
}

const ZH = {
  welcome: '欢迎使用 Aalis。按 Ctrl+G 查看快捷键。',
  attachment: '[图片] 猫.png https://example.invalid/cat.png',
  heading: '需要批准 exec · 会话 cli-default',
  keys: '←/→ 选择 · Enter 确定 · Ctrl+Y 批准 · Ctrl+N 拒绝',
  settled: '审批 exec：已批准',
  help: '视图切换',
};
const EN = {
  welcome: 'Welcome to Aalis. Press Ctrl+G to see the shortcuts.',
  attachment: '[Image] 猫.png https://example.invalid/cat.png',
  heading: 'Approval needed exec · session cli-default',
  keys: '←/→ choose · Enter confirm · Ctrl+Y approve · Ctrl+N deny',
  settled: 'Approval for exec: approved',
  help: 'Switching views',
};

describe('终端界面按全局层的语言', () => {
  it.each([
    ['全局层为 en：英文', { language: ['en'] }, EN, ZH],
    ['全局层为 zh-CN：原文', { language: ['zh-CN'] }, ZH, EN],
    ['终端会话自己设了 en、全局层为 zh-CN：原文', { language: ['zh-CN'], cliLanguage: ['en'] }, ZH, EN],
    ['i18n 缺席：原文', { language: ['en'], i18nMode: 'absent' as const }, ZH, EN],
  ])('%s', async (_case, options, shown, other) => {
    const s = await setup(options);
    await s.send({
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: 'https://example.invalid/cat.png', name: '猫.png' }],
    });
    await vi.waitFor(() => expect(s.frame()).toContain(shown.attachment));
    expect(s.frame()).toContain(shown.welcome);
    expect(s.frame()).not.toContain(other.welcome);
    expect(s.frame()).not.toContain(other.attachment);

    await s.touch();
    await s.request();
    expect(s.frame()).toContain(shown.heading);
    expect(s.frame()).toContain(shown.keys);
    expect(s.frame()).not.toContain(other.heading);
    await s.ctrl('y');
    expect(s.frame()).toContain(shown.settled);

    await s.ctrl('g');
    expect(s.frame()).toContain(shown.help);
    expect(s.frame()).not.toContain(other.help);
  });

  it('宿主配置里的语言变了立即重绘：停在帮助页时把语言改成 zh-CN，不按键就换成中文', async () => {
    const s = await setup({ language: ['en'] });
    await s.ctrl('g');
    expect(s.frame()).toContain(EN.help);
    await s.setLanguage(['zh-CN']);
    await settle();
    expect(s.frame()).toContain(ZH.help);
    expect(s.frame()).not.toContain(EN.help);
  });

  it.each([
    ['zh-CN', '^T 聊天  ·  ^L 日志  ·  ^S 状态  ·  ^G 帮助  ·  Esc 返回  ·  ^C 退出', '换行：关', '换行：开'],
    ['en', '^T Chat  ·  ^L Logs  ·  ^S Status  ·  ^G Help  ·  Esc Back  ·  ^C Exit', 'Wrap: off', 'Wrap: on'],
  ])('底栏的按键提示按 %s：按键记号照旧，后面的词取字典；日志页另有换行的开关', async (language, keys, off, on) => {
    const s = await setup({ language: [language] });
    const footer = () => s.frame().split('\n').at(-1)?.trim();
    expect(footer()).toBe(keys);
    await s.ctrl('l');
    expect(footer()).toBe(`${keys}  ·  ^W ${off}`);
    await s.ctrl('w');
    expect(footer()).toBe(`${keys}  ·  ^W ${on}`);
  });

  it('帮助页按终端宽度折行：80 列下英文的每一句都完整，没有截断的行，断行落在空格处', async () => {
    const s = await setup({ language: ['en'], rows: 60, columns: 80 });
    await s.ctrl('g');
    const lines = s.frame().split('\n');
    expect(lines.filter(line => line.includes('…'))).toEqual([]);
    const page = lines.join('').replace(/\s+/g, '');
    const texts = Object.entries(en).filter(([key]) => /^(help|tip)/.test(key));
    for (const [key, text] of texts) expect(page, key).toContain(text.replace(/\s+/g, ''));
    const words = texts.flatMap(([, text]) => text.split(/\s+/)).filter(Boolean);
    expect(words.filter(word => !lines.some(line => line.includes(word)))).toEqual([]);
  });

  it('80 列下英文审批卡的按键提示完整显示', async () => {
    const s = await setup({ language: ['en'], columns: 80 });
    await s.touch();
    await s.request();
    expect(s.frame()).toContain(EN.keys);
  });

  it('审批卡上事实里伪造的文字对象原样显示，不按读者渲染', async () => {
    const s = await setup({ language: ['en'] });
    await s.touch();
    const forged = t('forged');
    await s.request({ args: { command: 'ls', x: forged } });
    expect(s.frame()).toContain(EN.heading);
    expect(s.frame()).toContain(JSON.stringify({ x: forged }));
    expect(s.frame()).not.toContain('<译文>');
  });

  it('审批卡上过长的事实保留首尾，省略的字数按读者语言写在中间', async () => {
    const s = await setup({ language: ['en'] });
    await s.touch();
    // 首尾各留 500 字，正好各自以换行收尾与开头：省略的那句单独成行，不被折行切开
    await s.request({ args: { command: `${'a'.repeat(499)}\n${'x'.repeat(3000)}\n${'b'.repeat(499)}` } });
    expect(s.frame()).toContain('…(3,000 characters omitted)…');
  });

  it('应答被拒的原因按读者语言：卡片推出之后终端身份不再能批这一张', async () => {
    const s = await setup({ language: ['en'] });
    await s.touch();
    await s.request();
    expect(s.frame()).toContain(EN.heading);
    s.demote();
    await s.ctrl('y');
    expect(s.frame()).toContain(
      'Approval for exec: the answer did not take effect: The responder cannot answer this approval',
    );
  });

  it('审批卡上事实的标签补齐到同一宽度：各项的值从同一列开始', async () => {
    const s = await setup({ language: ['en'] });
    await s.touch();
    await s.request({ args: { command: 'x'.repeat(150), x: 1 } });
    /** 这个标签那一行里值开始的列 */
    const valueColumn = (label: string) => {
      const line = s
        .frame()
        .split('\n')
        .find(l => l.includes(`${label} `));
      if (!line) throw new Error(`卡上没有 ${label} 一行`);
      const after = line.slice(line.indexOf(label) + label.length);
      return line.length - after.trimStart().length;
    };
    expect(valueColumn('Command')).toBe(valueColumn('Parameters'));
    // 放不下的值折到下一行，续行同样从值那一列开始
    const continued = s
      .frame()
      .split('\n')
      .filter(line => line.includes('xxxx') && !line.includes('Command'));
    expect(continued.length).toBeGreaterThan(0);
    for (const line of continued) expect(line.indexOf('x')).toBe(valueColumn('Command'));
  });

  it('i18n 的 render 抛错：界面照常按原文显示，每个出口只告警一次', async () => {
    const s = await setup({ language: ['en'], i18nMode: 'broken' });
    await s.send({
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: 'https://example.invalid/cat.png', name: '猫.png' }],
    });
    await vi.waitFor(() => expect(s.frame()).toContain(ZH.attachment));
    expect(s.frame()).toContain(ZH.welcome);
    await s.touch();
    await s.request();
    expect(s.frame()).toContain(ZH.heading);
    await s.ctrl('g');
    expect(s.frame()).toContain(ZH.help);
    // 终端界面与会话服务（终端经会话协议接着它，出帧同样按全局层的语言渲染）是两个出口
    const warnings = s.renderWarnings();
    expect(warnings.filter(message => message.includes('界面文字'))).toHaveLength(1);
    expect(warnings).toHaveLength(new Set(warnings).size);
  });
});

describe('送达失败的原因', () => {
  const failure = t('failure');

  /**
   * 启动终端界面，返回「发一条出站、等它的回执」。写进聊天区时要取人设的名字：只让发出后的第一次取不到，抛出挂着文字对象的报错。
   * subscribed 时另接上会话服务、等终端订上它的会话：她回复的正文由条目画，出站只写附件那一行
   */
  async function failingTerminal(subscribed = false) {
    cleanups.push(fakeTty(20, 100).restore);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const app = new App({ logLevel: 'error' });
    // 接会话服务时事件由它装的枢纽提供
    if (!subscribed) provideEvents(app);
    cleanups.push(() => app.stop());
    const host = app.bind({ provide, events });
    let failNext = false;
    host.provide.use(persona, {
      getPersonaName: () => {
        if (!failNext) return 'Aalis';
        failNext = false;
        throw new TextError(failure);
      },
    } as never);
    let session: { subscribed: Promise<void> } | undefined;
    if (subscribed) {
      const home = mkdtempSync(join(tmpdir(), 'aalis-cli-i18n-'));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      session = await attachSessionServer(app, home);
    }
    await app.plugin(cliPlugin, {});
    await app.start();
    await session?.subscribed;
    await settle();
    return async (message: Omit<OutgoingMessage, 'sessionId' | 'platform'>) => {
      const outgoing: OutgoingMessage = { sessionId: 'cli-default', platform: 'cli', ...message };
      failNext = true;
      await host.events.use.emit('outbound:message', outgoing);
      return outgoing.delivery;
    };
  }

  it('写出时抛出挂着文字对象的报错（人设服务取名字时抛出）：回执交出那个文字对象', async () => {
    const send = await failingTerminal();
    expect(await send({ content: '<回复>', source: 'system' })).toEqual({ ok: false, error: failure });
  });

  it.each([
    ['只带附件的出站写不出', '', false],
    ['带正文与附件的出站（正文先写，写不出）', '<正文>', false],
    ['订着终端的会话时带正文与附件的出站（正文由条目画，附件那一行写不出）', '<正文>', true],
  ])('%s：回执交出那个文字对象，没有未处理的拒绝', async (_case, content, subscribed) => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    cleanups.push(() => void process.off('unhandledRejection', onRejection));
    const send = await failingTerminal(subscribed);
    const delivery = await send({
      content,
      source: 'agent',
      attachments: [{ kind: 'image', data: 'https://example.invalid/cat.png', name: '猫.png' }],
    });
    expect(delivery).toEqual({ ok: false, error: failure });
    await settle();
    expect(rejections).toEqual([]);
  });
});

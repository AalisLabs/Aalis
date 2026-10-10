import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Approval,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalSurface,
  approvals,
} from '../../packages/api-approval/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, definePlugin, events, type Logger, optional, provide } from '../../packages/core/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { declareToolSystemDisplays } from '../fixtures/tool-display.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// 终端的审批面：plugin-cli 登记 cli 审批面，终端界面以本地终端身份接入。有按键才上报在场；审批推来时
// 输入框换成模态的审批卡，卡上的事实经清洗，用方向键加回车或专用快捷键应答，打字与回车不算应答。
// 起真的会话服务（审批服务）与真 TUI（假 TTY，收集 stdout 帧），审批直接经 approvals 发起。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const CONSOLE = { platform: 'cli', userId: 'console' };
const isOwner = (p: string, u?: string) => (p === 'cli' || p === 'webui') && u === 'console';

const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');
/** 等两拍：渲染排在 setImmediate 上 */
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));

/** 另一个审批面（WebUI），用来让审批在终端不在场时也挂着 */
const webuiPlugin = (out: { surface?: ApprovalSurface }) =>
  definePlugin({
    name: '@test/webui-surface',
    uses: { approvals: optional(approvals) },
    apply: ({ approvals }) => {
      out.surface = approvals.use.registerSurface('webui');
    },
  });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

interface Setup {
  tty?: boolean;
  startupView?: string;
  /** 权限服务认谁是 owner；缺省认本地终端与 WebUI 控制台 */
  owner?: (platform: string, userId?: string) => boolean;
}

async function setup({ tty = true, startupView = 'chat', owner = isOwner }: Setup = {}) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    writes.push(String(chunk));
    return true;
  });
  if (tty) cleanups.push(fakeTty(30, 100).restore);
  else {
    const prev = { out: process.stdout.isTTY, in: process.stdin.isTTY };
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    cleanups.push(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: prev.out, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: prev.in, configurable: true });
    });
  }
  const home = mkdtempSync(join(tmpdir(), 'aalis-cli-approvals-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const app = new App({ name: 'T', logLevel: 'error', logger: silent });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  const { state } = provideHostPaths(app, home);
  const host = app.bind({ provide, events, approvals, tools });
  host.provide.use(storage, memoryStorage(new Map()));
  host.provide.use(authority, { isOwner: owner } as never);
  // 卡上的事实按工具声明的展示种类取
  await app.plugin(toolsPlugin, {});
  await app.plugins.idle();
  declareToolSystemDisplays(host.tools.use);
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  await app.plugin(cliPlugin, { startupView });
  const webui: { surface?: ApprovalSurface } = {};
  await app.plugin(webuiPlugin(webui));
  await app.plugins.idle();
  for (const name of [sessionServerPlugin.name, cliPlugin.name, '@test/webui-surface']) {
    const s = app.plugins.getPlugin(name)?.state;
    if (s !== 'active') throw new Error(`${name} 未激活（state=${s}）`);
  }
  await app.start();
  await settle();

  const inbound: string[] = [];
  host.events.use.on('inbound:message', msg => void inbound.push(msg.content));
  /** 最后一帧的原样输出 */
  const rawFrame = () => {
    const all = writes.join('');
    const at = all.lastIndexOf(FRAME_SPLIT);
    return at < 0 ? all : all.slice(at);
  };
  const frame = () => stripAnsi(rawFrame());
  /** 按一个键 */
  const press = async (name: string, mods: { ctrl?: boolean } = {}) => {
    process.stdin.emit('keypress', name === 'return' ? '\r' : '', { name, ...mods });
    await settle();
  };
  /** 打一串字 */
  const type = async (text: string) => {
    for (const ch of text) process.stdin.emit('keypress', ch, { name: ch, sequence: ch });
    await settle();
  };
  const request = (over: Partial<ApprovalRequest> = {}, signal?: AbortSignal) => {
    const box: { outcome?: ApprovalOutcome } = {};
    const promise = host.approvals.use.request(
      {
        sessionId: 'cli-default',
        origin: { kind: 'owner', ...CONSOLE },
        tool: 'exec',
        args: { command: 'ls' },
        rule: 'tool:exec 声明需确认',
        ...over,
      },
      signal,
    );
    void promise.then(outcome => {
      box.outcome = outcome;
    });
    return Object.assign(box, { promise });
  };
  const pending = () => host.approvals.use.list();
  const audit = async (n: number) => {
    const file = join(state, 'audit', 'approvals.jsonl');
    const read = () =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>);
    await vi.waitFor(() => expect(read()).toHaveLength(n));
    return read();
  };
  /** WebUI 上一个在场的 owner 客户端，回它收到的审批 */
  const webuiPresent = () => {
    const received: Approval[] = [];
    webui.surface
      ?.attend({ platform: 'webui', userId: 'console' }, { requested: a => void received.push(a), settled() {} })
      .presence(true);
    return received;
  };
  return { writes, rawFrame, frame, press, type, request, pending, inbound, audit, webuiPresent };
}

describe('在场：终端最近有输入才算在场', () => {
  it('从没按过键：审批立即按没人在场拒绝，不出卡；按过键之后卡片推到终端', async () => {
    const s = await setup();
    const absent = await s.request().promise;
    expect(absent).toMatchObject({ approved: false, source: 'absent' });
    expect(s.frame()).not.toContain('需要批准');

    await s.type('a');
    const r = s.request();
    await settle();
    expect(s.frame()).toContain('需要批准');
    expect(r.outcome).toBeUndefined();
  });

  it('在日志页按键同样算在场，卡片在日志页也显示', async () => {
    const s = await setup({ startupView: 'logs' });
    await s.press('up');
    s.request();
    await settle();
    expect(s.frame()).toContain('[LOGS]');
    expect(s.frame()).toContain('需要批准');
    // 在日志页应答：结算的那一行进了聊天区，CHAT 页签带计数
    await s.press('y', { ctrl: true });
    expect(s.frame()).not.toContain('需要批准');
    expect(s.frame()).toContain('CHAT(1)');
  });

  it('按键让终端变为在场时补推来的卡，不接这次按键：这次按键照常处理，从下一次按键起才算应答', async () => {
    const s = await setup();
    const atWebui = s.webuiPresent();
    const r = s.request();
    await settle();
    expect(atWebui, '审批先挂在 WebUI 上').toHaveLength(1);
    expect(s.frame()).not.toContain('需要批准');

    // 终端不在场时按下的 ←：补推来的卡这时才出现，owner 还没看到它，← 不选批准
    await s.press('left');
    expect(s.frame()).toContain('需要批准');
    expect(s.frame()).not.toContain('❯ 批准');
    await s.press('return');
    expect(r.outcome).toBeUndefined();
    await s.press('left');
    expect(s.frame()).toContain('❯ 批准');
  });

  it('权限服务不认终端身份是 owner：按键也不算在场，收不到卡；审批只推给在场的 owner 客户端', async () => {
    const s = await setup({ owner: (p, u) => p === 'webui' && u === 'console' });
    const origin = { kind: 'owner' as const, platform: 'webui', userId: 'console' };
    await s.type('a');
    expect(await s.request({ origin }).promise).toMatchObject({ approved: false, source: 'absent' });

    const atWebui = s.webuiPresent();
    const r = s.request({ origin });
    await settle();
    await s.type('b');
    expect(atWebui).toHaveLength(1);
    expect(s.frame()).not.toContain('需要批准');
    expect(r.outcome).toBeUndefined();
  });

  it('不在终端前（stdin/stdout 不是 TTY，不起界面）：没有在场的客户端，审批立即按没人在场拒绝', async () => {
    const s = await setup({ tty: false });
    expect(await s.request().promise).toMatchObject({ approved: false, source: 'absent' });
  });
});

describe('卡片显示', () => {
  it('事实经清洗：转义序列与双向控制符都看得见，原样的控制符不写到终端', async () => {
    const s = await setup();
    await s.type('a');
    s.request({ args: { command: 'rm -rf build\x1b[2J\u202Etxt.exe', cwd: '/srv/app', timeout: 5 } });
    await settle();
    const frame = s.frame();
    expect(frame).toContain('rm -rf build\\x1B[2J⟨U+202E⟩txt.exe');
    expect(frame).toContain('/srv/app');
    expect(frame).toContain('{"timeout":5}');
    expect(frame).toContain('exec');
    expect(frame).toContain('cli-default');
    const raw = s.writes.join('');
    expect(raw).not.toContain('build\x1b[2J');
    expect(raw).not.toContain('\u202E');
    // 卡片在时输入框让位，不显示光标
    expect(s.rawFrame()).not.toContain('\x1b[?25h');
  });

  it('diff 逐行显示；疑似密钥的只给路径', async () => {
    const s = await setup();
    await s.type('a');
    s.request({
      tool: 'file_edit',
      args: { path: 'src/app.ts', oldText: 'const a = 1;', newText: 'if (a)\n\treturn 2;' },
    });
    await settle();
    expect(s.frame()).toContain('src/app.ts');
    expect(s.frame()).toContain('-const a = 1;');
    expect(s.frame()).toContain('+if (a)');
    // 制表符按空格显示，不原样写到终端
    expect(s.frame()).toContain('+    return 2;');
    expect(s.rawFrame()).not.toContain('\t');
    await s.press('y', { ctrl: true });

    s.request({ tool: 'file_write', args: { path: '.env', content: 'API_KEY=abcdefgh12345678' } });
    await settle();
    expect(s.frame()).toContain('.env');
    expect(s.frame()).not.toContain('abcdefgh12345678');
  });

  it.each([
    ['一行太长', `HEAD${'x'.repeat(5000)}TAIL`, '字'],
    ['行数太多', Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join('\n'), '行'],
  ])('%s：保留首尾，写明省略了多少', async (_case, command, unit) => {
    const s = await setup();
    await s.type('a');
    s.request({ args: { command } });
    await settle();
    const frame = s.frame();
    const [head, tail] = unit === '字' ? ['HEAD', 'TAIL'] : ['line-1 ', 'line-100'];
    expect(frame).toContain(head);
    expect(frame).toContain(tail);
    expect(frame).toMatch(new RegExp(`省略 \\d+ ${unit}`));
    // 卡片挤不掉标题栏与页脚
    expect(frame).toContain('[CHAT]');
    expect(frame).toContain('^C exit');
  });

  it('几张卡同时在：先显示先到的并写明还有几张，答完显示下一张', async () => {
    const s = await setup();
    await s.type('a');
    const first = s.request({ args: { command: 'echo first' } });
    const second = s.request({ sessionId: 'session-b', args: { command: 'echo second' } });
    await settle();
    expect(s.frame()).toContain('echo first');
    expect(s.frame()).toContain('还有 1 张');
    expect(s.frame()).not.toContain('echo second');

    await s.press('left');
    await s.press('return');
    expect(first.outcome).toMatchObject({ approved: true });
    expect(s.frame()).toContain('echo second');
    expect(s.frame()).toContain('session-b');
    expect(s.frame()).not.toContain('还有');
    // 下一张从不选中开始：上一张的选择不带过来，回车不算应答
    expect(s.frame()).not.toContain('❯ 批准');
    await s.press('return');
    expect(second.outcome).toBeUndefined();
  });
});

describe('模态应答', () => {
  it('推出时不选中，回车不算应答；← 选批准、→ 选拒绝，回车确定；审计记在 cli 审批面名下', async () => {
    const s = await setup();
    await s.type('a');
    const r = s.request();
    await settle();
    await s.press('return');
    expect(r.outcome, '没选就按回车不得应答').toBeUndefined();
    expect(s.pending()).toHaveLength(1);

    await s.press('right');
    expect(s.frame()).toContain('❯ 拒绝');
    await s.press('left');
    expect(s.frame()).toContain('❯ 批准');
    await s.press('return');
    expect(r.outcome).toMatchObject({ approved: true });
    expect(s.frame()).not.toContain('需要批准');
    expect(s.frame()).toContain('审批 exec：已批准');

    const [, decision] = await s.audit(2);
    expect(decision).toMatchObject({
      state: 'approved',
      source: 'owner',
      responder: CONSOLE,
      surface: { name: 'cli', plugin: '@aalis/plugin-cli' },
    });
  });

  it.each([
    ['Ctrl+Y 批准', 'y', { approved: true }],
    ['Ctrl+N 拒绝', 'n', { approved: false, source: 'owner' }],
  ])('专用快捷键：%s', async (_case, key, outcome) => {
    const s = await setup();
    await s.type('a');
    const r = s.request();
    await settle();
    await s.press(key, { ctrl: true });
    expect(r.outcome).toMatchObject(outcome);
    expect(s.frame()).not.toContain('需要批准');
  });

  it('卡片在时打字与回车都不算应答，也不进输入框、不发出去', async () => {
    const s = await setup();
    await s.type('ab');
    const r = s.request();
    await settle();
    await s.type('y');
    await s.press('return');
    await s.type('yes');
    await s.press('return');
    expect(r.outcome).toBeUndefined();
    expect(s.pending()).toHaveLength(1);
    expect(s.inbound).toEqual([]);

    await s.press('y', { ctrl: true });
    expect(r.outcome).toMatchObject({ approved: true });
    // 卡片之前打的字还在输入框里，卡片在时打的字没进去
    expect(s.frame()).toContain('You ab');
    expect(s.frame()).not.toContain('You aby');
  });

  it('应答被拒（卡片推出之后权限服务不再认终端身份是 owner）：卡片关掉，写明原因，审批照旧等别的面', async () => {
    let terminalIsOwner = true;
    const s = await setup({ owner: (p, u) => (p === 'webui' || (p === 'cli' && terminalIsOwner)) && u === 'console' });
    s.webuiPresent();
    await s.type('a');
    const r = s.request({ origin: { kind: 'owner', platform: 'webui', userId: 'console' } });
    await settle();
    expect(s.frame()).toContain('需要批准');
    terminalIsOwner = false;
    await s.press('y', { ctrl: true });
    expect(s.frame()).not.toContain('需要批准');
    expect(s.frame()).toContain('审批 exec：应答没有生效：应答人不是 owner');
    expect(r.outcome).toBeUndefined();
    expect(s.pending()).toHaveLength(1);
  });

  it('卡片在别处结算（回合中止）：卡片关掉，聊天区留一行', async () => {
    const s = await setup();
    await s.type('a');
    const turn = new AbortController();
    const r = s.request({}, turn.signal);
    await settle();
    expect(s.frame()).toContain('需要批准');
    turn.abort();
    await r.promise;
    await settle();
    expect(s.frame()).not.toContain('需要批准');
    expect(s.frame()).toContain('审批 exec：已撤销');
  });
});

import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, DefaultLogger, LogHub } from '../../packages/core/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import { formatLogLine } from '../../packages/schema-log/src/index.js';
import { provideHostLogs } from '../fixtures/host-logs.js';
import { provideEvents } from '../fixtures/hubs.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// CLI 的日志页经 host-logs 订阅：激活时补发文件日志里的历史（启动期的也在其中），界面启动以后实时的接着显示。
// 启动真 TUI（mock isTTY + 收集 stdout 帧）看日志页
// ════════════════════════════════════════════════════════════

const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** 20 行的终端停在日志页；early 在激活前写日志（之后作为历史补发） */
async function setup(early: (probe: DefaultLogger) => void) {
  cleanups.push(fakeTty(20, 100).restore);
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    writes.push(String(chunk));
    return true;
  });
  const dir = mkdtempSync(join(tmpdir(), 'aalis-cli-logs-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'latest.log');
  const hub = new LogHub();
  hub.onEntry(entry => appendFileSync(file, formatLogLine(entry)));
  const probe = new DefaultLogger('aalis:zz-probe', 'info', hub);
  early(probe);
  const app = new App({ logLevel: 'error', logHub: hub });
  provideEvents(app);
  cleanups.push(() => app.stop());
  provideHostLogs(app, { hub, file });
  await app.plugin(cliPlugin, { startupView: 'logs' });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(cliPlugin.name)?.state).toBe('active');
  await app.start();
  const lastFrame = () => {
    const all = writes.join('');
    return all.slice(all.lastIndexOf(FRAME_SPLIT)).replace(ANSI_RE, '');
  };
  return { probe, lastFrame };
}

describe('plugin-cli 日志页', () => {
  it('显示补发的历史与之后的实时日志', async () => {
    const { probe, lastFrame } = await setup(probe => probe.info('启动期的一条'));
    await vi.waitFor(() => expect(lastFrame()).toContain('启动期的一条'));

    probe.info('实时的一条');
    await settle();
    expect(lastFrame()).toContain('实时的一条');
  });

  it('按 Home 到顶：视图说明里的 scroll 是钳制后的偏移，不带千分位', async () => {
    const { lastFrame } = await setup(probe => {
      for (let i = 0; i < 1100; i++) probe.info(`zz-${i}`);
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('zz-1099'));
    process.stdin.emit('keypress', '', { name: 'home' });
    await settle();
    const m = lastFrame().match(/logs · (\S+) 行 · scroll (\S+)/);
    expect(m, '帧里没有日志页的视图说明').not.toBeNull();
    const [, total, scroll] = m as RegExpMatchArray;
    // 一条一行；正文 14 行：20 行的终端减去头部、分隔线、底栏与视图说明的框（3 行）
    expect(scroll).toBe(String(Number(total.replace(/,/g, '')) - 14));
  });
});

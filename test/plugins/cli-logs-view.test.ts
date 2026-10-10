import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, DefaultLogger, LogHub } from '../../packages/core/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import { formatLogLine } from '../../packages/schema-log/src/index.js';
import { provideHostLogs } from '../fixtures/host-logs.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// CLI 的日志页经 host-logs 订阅：激活时补发文件日志里的历史（启动期的也在其中），界面起来以后实时的接着显示。
// 起真 TUI（mock isTTY + 收集 stdout 帧）看日志页
// ════════════════════════════════════════════════════════════

const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('plugin-cli 日志页', () => {
  it('显示补发的历史与之后的实时日志', async () => {
    const tty = fakeTty(20, 100);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    const dir = mkdtempSync(join(tmpdir(), 'aalis-cli-logs-'));
    dirs.push(dir);
    const file = join(dir, 'latest.log');
    const hub = new LogHub();
    hub.onEntry(entry => appendFileSync(file, formatLogLine(entry)));
    const probe = new DefaultLogger('aalis:zz-probe', 'info', hub);
    probe.info('启动期的一条');
    const app = new App({ name: 'T', logLevel: 'error', logHub: hub });
    provideHostLogs(app, { hub, file });
    const lastFrame = () => {
      const all = writes.join('');
      return all.slice(all.lastIndexOf(FRAME_SPLIT)).replace(ANSI_RE, '');
    };
    try {
      await app.plugin(cliPlugin, { startupView: 'logs' });
      await app.plugins.idle();
      expect(app.plugins.getPlugin(cliPlugin.name)?.state).toBe('active');
      await app.start();
      await vi.waitFor(() => expect(lastFrame()).toContain('启动期的一条'));

      probe.info('实时的一条');
      await settle();
      expect(lastFrame()).toContain('实时的一条');
    } finally {
      await app.stop().catch(() => {});
      tty.restore();
    }
  });
});

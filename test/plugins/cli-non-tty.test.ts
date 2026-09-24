import { App, events, LogHub } from '@aalis/core';
import type { LogEntry } from '@aalis/schema-log';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../../packages/api-platform/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';

// stdin / stdout 不是 TTY（日志重定向、容器、systemd）时 CLI 不得接管终端：
// 不写备用屏序列、不宣告 terminal:claimed（否则 runtime 的控制台日志会停写 stdout），
// 发往 cli 会话的消息退化为一行日志。旧行为是无条件进全屏界面，日志文件被 ANSI 占满。

const ALT_SCREEN = '\x1b[?1049h';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('plugin-cli 非 TTY', () => {
  // 两种情形都不能接管：都非 TTY（容器 / systemd），以及只有 stdout 被重定向（node index.mjs > app.log）
  it.each([
    { name: 'stdin/stdout 都非 TTY', stdin: false },
    { name: '只有 stdout 非 TTY', stdin: true },
  ])('$name：不接管终端；出站消息落成日志', async ({ stdin }) => {
    const tty = { out: process.stdout.isTTY, in: process.stdin.isTTY };
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    const entries: LogEntry[] = [];
    const offLog = LogHub.default.onEntry(e => entries.push(e));

    const app = new App({ name: 'T', logLevel: 'info' });
    // 宿主侧按根激活取绑定接口：事件订阅与平台枚举都走公开门面
    const host = app.bind({ events, platform });
    const claimed = vi.fn();
    host.events.on('terminal:claimed', claimed);
    try {
      await app.plugin(cliPlugin, {});
      await app.start();
      // 插件若停在 pending，「没接管终端」三条会一起变成恒真
      expect(app.plugins.getPlugin(cliPlugin.name)?.state, 'cli 插件未激活').toBe('active');

      expect(writes.join('')).not.toContain(ALT_SCREEN);
      expect(claimed).not.toHaveBeenCalled();
      expect(entries.some(e => e.message.includes('CLI 界面未启动'))).toBe(true);

      const cli = host.platform.all().find(p => p.instance.platform === 'cli');
      expect(cli, 'cli 平台服务应已注册').toBeDefined();
      await cli?.instance.sendMessage('cli-default', 'probe-reply');
      expect(entries.some(e => e.message.includes('[cli] probe-reply'))).toBe(true);
    } finally {
      offLog();
      await app.stop().catch(() => {});
      Object.defineProperty(process.stdout, 'isTTY', { value: tty.out, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: tty.in, configurable: true });
    }
  });
});

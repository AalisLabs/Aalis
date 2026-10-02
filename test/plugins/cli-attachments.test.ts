import { App, events, LogHub } from '@aalis/core';
import type { LogEntry } from '@aalis/schema-log';
import type { OutgoingMessage } from '@aalis/schema-message';
import { afterEach, describe, expect, it, vi } from 'vitest';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import { fakeTty } from '../helpers/tty.js';

// CLI 会话里的附件：终端显示不了图片本身，写一行说明（类型、名称、大小、本机路径；取不到路径时写存储地址），
// 写出即算送达（填 delivery 并发 outbound:delivered，照常归档）。附件消息不往终端写空行。
// 用非 TTY 模式：出站消息落成 `[cli] …` 日志，便于断言。流式去重那一支只在 TUI 里走到，那条用例起真 TUI。

afterEach(() => {
  vi.restoreAllMocks();
});

describe('plugin-cli 附件', () => {
  it('附件写成一行说明并算送达；没有存储服务时写存储地址；附件消息不写空行', async () => {
    const tty = { out: process.stdout.isTTY, in: process.stdin.isTTY };
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const entries: LogEntry[] = [];
    const offLog = LogHub.default.onEntry(e => entries.push(e));
    const app = new App({ name: 'T', logLevel: 'info' });
    const host = app.bind({ events });
    const delivered: OutgoingMessage[] = [];
    host.events.on('outbound:delivered', msg => void delivered.push(msg));
    try {
      await app.plugin(cliPlugin, {});
      await app.start();
      expect(app.plugins.getPlugin(cliPlugin.name)?.state).toBe('active');

      const message: OutgoingMessage = {
        sessionId: 'cli-default',
        platform: 'cli',
        content: '',
        source: 'agent',
        attachments: [
          { kind: 'image', data: 'data:/images/cat.png', name: '猫.png' },
          { kind: 'file', data: 'https://example.invalid/page.html', name: '主页.html' },
          { kind: 'audio', data: 'https://example.invalid/hello.mp3', name: '问好.mp3' },
          { kind: 'video', data: 'https://example.invalid/clip.mp4', name: '片段.mp4' },
        ],
      };
      await host.events.emit('outbound:message', message);
      expect(message.delivery, 'CLI 认领了这条消息').toBeDefined();
      expect(await message.delivery).toEqual({ ok: true });

      const lines = entries.map(e => e.message).filter(m => m.startsWith('[cli]'));
      expect(lines).toContain('[cli] [图片] 猫.png · data:/images/cat.png');
      expect(lines).toContain('[cli] [文件] 主页.html https://example.invalid/page.html');
      expect(lines, '类型名与归档占位符一致').toContain('[cli] [音频] 问好.mp3 https://example.invalid/hello.mp3');
      expect(lines).toContain('[cli] [视频] 片段.mp4 https://example.invalid/clip.mp4');
      expect(lines, '附件消息的空正文不写成空行').not.toContain('[cli] ');
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(delivered[0].attachments?.map(a => a.data)).toEqual([
        'data:/images/cat.png',
        'https://example.invalid/page.html',
        'https://example.invalid/hello.mp3',
        'https://example.invalid/clip.mp4',
      ]);

      // 对照：别的会话的附件不认领
      const other: OutgoingMessage = {
        sessionId: 'onebot:group:x',
        content: '',
        source: 'agent',
        attachments: [{ kind: 'image', data: 'data:/images/cat.png' }],
      };
      await host.events.emit('outbound:message', other);
      expect(other.delivery).toBeUndefined();
    } finally {
      offLog();
      await app.stop().catch(() => {});
      Object.defineProperty(process.stdout, 'isTTY', { value: tty.out, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: tty.in, configurable: true });
    }
  });

  it('纯文本（如作品通知）写出即算送达，同样认领回执', async () => {
    const tty = { out: process.stdout.isTTY, in: process.stdin.isTTY };
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const entries: LogEntry[] = [];
    const offLog = LogHub.default.onEntry(e => entries.push(e));
    const app = new App({ name: 'T', logLevel: 'info' });
    const host = app.bind({ events });
    try {
      await app.plugin(cliPlugin, {});
      await app.start();

      for (const source of ['system', 'agent'] as const) {
        const message: OutgoingMessage = {
          sessionId: 'cli-default',
          platform: 'cli',
          content: `[作品通知] 《猫》已上线 (${source})`,
          source,
        };
        await host.events.emit('outbound:message', message);
        expect(message.delivery, `CLI 认领了 ${source} 文本`).toBeDefined();
        expect(await message.delivery).toEqual({ ok: true });
        expect(entries.map(e => e.message)).toContain(`[cli] [作品通知] 《猫》已上线 (${source})`);
      }
    } finally {
      offLog();
      await app.stop().catch(() => {});
      Object.defineProperty(process.stdout, 'isTTY', { value: tty.out, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: tty.in, configurable: true });
    }
  });

  it('TUI 里已流式写出的回复：去重跳过整条回复时，回执照样认领为送达', async () => {
    const tty = fakeTty(20, 100);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const app = new App({ name: 'T', logLevel: 'error' });
    const host = app.bind({ events });
    const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));
    try {
      await app.plugin(cliPlugin, {});
      await app.start();
      await settle();
      const stream = (chunk: Record<string, unknown>) =>
        host.events.emit('outbound:stream', { sessionId: 'cli-default', platform: 'cli', ...chunk } as never);
      await stream({ contentDelta: '画好了' });
      await stream({ done: true });
      const message: OutgoingMessage = {
        sessionId: 'cli-default',
        platform: 'cli',
        content: '画好了',
        source: 'agent',
      };
      await host.events.emit('outbound:message', message);
      expect(message.delivery, '流式去重那一支同样认领回执').toBeDefined();
      expect(await message.delivery).toEqual({ ok: true });
    } finally {
      await app.stop().catch(() => {});
      tty.restore();
    }
  });
});

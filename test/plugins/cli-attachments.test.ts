import { App, events, LogHub } from '@aalis/core';
import type { LogEntry } from '@aalis/schema-log';
import type { OutgoingMessage } from '@aalis/schema-message';
import { afterEach, describe, expect, it, vi } from 'vitest';
import cliPlugin from '../../packages/plugin-cli/src/index.js';

// CLI 会话里的附件：终端显示不了图片本身，写一行说明（类型、名称、大小、本机路径；取不到路径时写存储地址），
// 写出即算送达（填 delivery 并发 outbound:delivered，照常归档）。附件消息不往终端写空行。
// 用非 TTY 模式：出站消息落成 `[cli] …` 日志，便于断言。

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
        ],
      };
      await host.events.emit('outbound:message', message);
      expect(message.delivery, 'CLI 认领了这条消息').toBeDefined();
      expect(await message.delivery).toEqual({ ok: true });

      const lines = entries.map(e => e.message).filter(m => m.startsWith('[cli]'));
      expect(lines).toContain('[cli] [图片] 猫.png · data:/images/cat.png');
      expect(lines).toContain('[cli] [文件] 主页.html https://example.invalid/page.html');
      expect(lines, '附件消息的空正文不写成空行').not.toContain('[cli] ');
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(delivered[0].attachments?.map(a => a.data)).toEqual([
        'data:/images/cat.png',
        'https://example.invalid/page.html',
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
});

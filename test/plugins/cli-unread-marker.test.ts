import { App, events } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// 非 chat 视图期间进入聊天区的消息（意图确认提示走的就是 outbound:message）此前没有任何可见
// 提示：用户停在 logs 页，确认问题在 chat 页静静等 60 秒后取消。契约：header 的 CHAT 页签带
// 计数高亮，切回 chat 即清。起真 TUI（mock isTTY + 收集 stdout 帧）看 header。
// ════════════════════════════════════════════════════════════

const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('plugin-cli 非 chat 视图的聊天区新消息提示', () => {
  it('logs 页收到消息 → CHAT 页签带计数；再来一条计数递增；Ctrl+T 切回 chat 即清', async () => {
    const tty = fakeTty(20, 100);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    const app = new App({ name: 'T', logLevel: 'error' });
    const lastFrame = () => {
      const all = writes.join('');
      const idx = all.lastIndexOf(FRAME_SPLIT);
      return stripAnsi(idx < 0 ? all : all.slice(idx));
    };
    // 宿主侧的发消息口：与插件同一套描述符，登记归属根激活
    const host = app.bind({ events });
    const send = (content: string) =>
      host.events.emit('outbound:message', { content, sessionId: 'cli-default', platform: 'cli', source: 'system' });
    try {
      await app.plugin(cliPlugin, { startupView: 'logs' });
      await app.plugins.idle();
      // 激活闸会让缺依赖的插件停在 pending 而不报错：不核一下，下面的 header 断言会
      // 在「TUI 压根没起来」上变成对空帧的比对。
      const state = app.plugins.getPlugin(cliPlugin.name)?.state;
      if (state !== 'active') throw new Error(`plugin-cli 未激活（state=${state}）`);
      await app.start();
      await settle();
      expect(lastFrame()).toContain('[LOGS]');
      expect(lastFrame()).not.toMatch(/CHAT\(\d+\)/);

      await send('需要确认：执行 exec（command: rm -rf ./build）？回复 y / ys');
      await settle();
      expect(lastFrame(), 'logs 页收到消息后 header 应带计数').toContain('CHAT(1)');

      await send('第二条');
      await settle();
      expect(lastFrame()).toContain('CHAT(2)');

      // 流式回复：首块计一次，后续块与收尾不再计；随后整条 outbound:message 被流式去重吃掉，也不双计
      const stream = (chunk: Record<string, unknown>) =>
        host.events.emit('outbound:stream', { sessionId: 'cli-default', platform: 'cli', ...chunk } as never);
      await stream({ contentDelta: '流式' });
      await stream({ contentDelta: '回复' });
      await stream({ done: true });
      await settle();
      expect(lastFrame()).toContain('CHAT(3)');
      await host.events.emit('outbound:message', {
        content: '流式回复',
        sessionId: 'cli-default',
        platform: 'cli',
        source: 'agent',
      });
      await settle();
      expect(lastFrame(), '流式后的整条回复不得再计一次').toContain('CHAT(3)');

      process.stdin.emit('keypress', '', { name: 't', ctrl: true });
      await settle();
      const frame = lastFrame();
      expect(frame).toContain('[CHAT]');
      expect(frame, '切回 chat 后计数应清零').not.toMatch(/CHAT\(\d+\)/);
    } finally {
      await app.stop().catch(() => {});
      tty.restore();
    }
  });
});

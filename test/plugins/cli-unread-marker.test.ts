import { App } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import cliPlugin from '../../packages/plugin-cli/src/index.js';

// ════════════════════════════════════════════════════════════
// 非 chat 视图期间进入聊天区的消息（意图确认提示走的就是 outbound:message）此前没有任何可见
// 提示：用户停在 logs 页，确认问题在 chat 页静静等 60 秒后取消。契约：header 的 CHAT 页签带
// 计数高亮，切回 chat 即清。起真 TUI（mock isTTY + 收集 stdout 帧）看 header。
// ════════════════════════════════════════════════════════════

const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function fakeTty(rows: number, columns: number): { restore(): void } {
  const prev = {
    out: process.stdout.isTTY,
    in: process.stdin.isTTY,
    rows: process.stdout.rows,
    columns: process.stdout.columns,
  };
  const stdin = process.stdin as unknown as { setRawMode?: (v: boolean) => unknown };
  const hadRawMode = typeof stdin.setRawMode === 'function';
  if (!hadRawMode) stdin.setRawMode = () => stdin;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  return {
    restore() {
      if (!hadRawMode) delete stdin.setRawMode;
      Object.defineProperty(process.stdout, 'isTTY', { value: prev.out, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: prev.in, configurable: true });
      Object.defineProperty(process.stdout, 'rows', { value: prev.rows, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: prev.columns, configurable: true });
    },
  };
}

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
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const lastFrame = () => {
      const all = writes.join('');
      const idx = all.lastIndexOf(FRAME_SPLIT);
      return stripAnsi(idx < 0 ? all : all.slice(idx));
    };
    const send = (content: string) =>
      app.ctx.emit('outbound:message', { content, sessionId: 'cli-default', platform: 'cli', source: 'system' });
    try {
      await app.ctx.useModule(cliPlugin, { startupView: 'logs' });
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
        app.ctx.emit('outbound:stream', { sessionId: 'cli-default', platform: 'cli', ...chunk } as never);
      await stream({ contentDelta: '流式' });
      await stream({ contentDelta: '回复' });
      await stream({ done: true });
      await settle();
      expect(lastFrame()).toContain('CHAT(3)');
      await app.ctx.emit('outbound:message', {
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

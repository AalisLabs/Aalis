import { App } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import cliPlugin from '../../packages/plugin-cli/src/index.js';

// Help 页自己宣传「Home/End 滚动 Logs / Status / Help」，但 handleScrollKey 只认
// home（End 只在 logs 页的 handleLogsKey 里实现过）——按 End 无任何反应，是个假按键。
// 这里起真 TUI（mock isTTY + 收集 stdout 帧），按 End 后看 footer 的 scroll 计数与底部内容。

const FRAME_SPLIT = '\x1b[?25l\x1b[H';

/** 等两拍：queueRender 走 setImmediate */
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));

interface TtyPatch {
  restore(): void;
}

function fakeTty(rows: number, columns: number): TtyPatch {
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

/**
 * 起 CLI（直接进 help 页），先按完 prelude 里的按键（其效果算进 before 帧），
 * 再按 keyName，返回按键前后的最后一帧。
 */
async function framesAroundKey(keyName: string, prelude: string[] = []): Promise<{ before: string; after: string }> {
  const tty = fakeTty(20, 100);
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    writes.push(String(chunk));
    return true;
  });
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  try {
    await app.plugin(cliPlugin, { startupView: 'help' });
    await app.plugins.idle();
    // 激活闸会让缺依赖的插件停在 pending 而不报错：不核一下，下面的帧断言会在
    // 「TUI 压根没起来」上变成对空帧的比对。
    const state = app.plugins.getPlugin(cliPlugin.name)?.state;
    if (state !== 'active') throw new Error(`plugin-cli 未激活（state=${state}）`);
    await app.start();
    await settle();
    const lastFrame = () => {
      const all = writes.join('');
      const idx = all.lastIndexOf(FRAME_SPLIT);
      return idx < 0 ? all : all.slice(idx);
    };
    for (const k of prelude) {
      process.stdin.emit('keypress', '', { name: k });
      await settle();
    }
    const before = lastFrame();
    process.stdin.emit('keypress', '', { name: keyName });
    await settle();
    return { before, after: lastFrame() };
  } finally {
    await app.stop().catch(() => {});
    tty.restore();
  }
}

const scrollOf = (frame: string): number => {
  const m = frame.match(/help · (\d+) 行 · scroll (\d+)/);
  expect(m, `帧里没有 help 页 footer：${JSON.stringify(frame.slice(-200))}`).not.toBeNull();
  return Number((m as RegExpMatchArray)[2]);
};

describe('plugin-cli Help 页滚动', () => {
  it('按 End 滚到底部（footer scroll 变正、底部提示可见、顶部标题移出视野）', async () => {
    const { before, after } = await framesAroundKey('end');
    expect(scrollOf(before), '起始应在顶部').toBe(0);
    expect(before, '视图容不下整页时本用例才有意义').toContain('视图切换');
    expect(before, '帮助页按键表漏了 End 行（宣传 Home 却不提 End）').toMatch(/End\s+到底部/);
    expect(scrollOf(after), '按 End 没反应，仍停在顶部').toBeGreaterThan(0);
    expect(after, 'End 后应看到页尾的提示段').toContain('输入以 / 开头');
    expect(after, 'End 后顶部标题应已滚出视野').not.toContain('视图切换');
  });

  it('按 Home 从底部回到顶部（反向锚：先 End 滚下去，再 Home 滚回来）', async () => {
    const { before, after } = await framesAroundKey('home', ['end']);
    expect(scrollOf(before), 'Home 之前得先真的不在顶部，否则这条恒真').toBeGreaterThan(0);
    expect(scrollOf(after), '按 Home 没回到顶部').toBe(0);
    expect(after).toContain('视图切换');
  });
});

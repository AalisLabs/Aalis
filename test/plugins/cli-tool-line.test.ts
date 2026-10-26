import { describe, expect, it } from 'vitest';
import { languageOf, type ToolCallItem, toolLine } from '../../packages/plugin-cli/src/fold.js';
import { resolveSource, resolveText } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// 终端聊天区工具调用的一行（plugin-cli 的 fold.ts 的 toolLine）。前半写做了什么：声明了命令展示的写「执行 <命令第一行>」，超过
// 60 字保留首尾、写明省略几个字；改文件的不带 removed 写「写入 <路径>」、带的写「修改 <路径>」；其余与认不出的展示种类写「调用
// <工具名>」。来自参数与模型的文字经审批契约的清洗，换行与制表符同样写成转义：一个调用只占一行。后半按状态写，等你批准的醒目、
// 失败的危险色；完成的写用时（一分钟以内到十分之一秒，数字按聊天区实际用的语言写），转到后台、任务还在跑的写明。按原文渲染
// ════════════════════════════════════════════════════════════

const call = (fields: Partial<ToolCallItem> = {}): ToolCallItem => ({
  kind: 'tool-call',
  itemId: 'c1',
  turnId: 't1',
  at: 0,
  name: 'zz_tool',
  args: {},
  status: 'completed',
  ...fields,
});
const command = (line: string, fields: Partial<ToolCallItem> = {}) =>
  call({ name: 'exec', display: { kind: 'command', command: line }, ...fields });
const settled = (state: 'approved' | 'denied') => ({ state, source: 'answer' as const, at: 0 });

/** 原文渲染的一行；running 是还在跑的后台任务 */
function rendered(item: ToolCallItem, running: string[] = []) {
  const { summary, status } = toolLine(item, taskId => running.includes(taskId), 'zh-CN');
  return { summary: resolveSource(summary), status: status && { text: resolveSource(status.text), tone: status.tone } };
}

describe('终端工具调用的一行：做了什么', () => {
  it.each([
    ['命令只写第一行', command('ls -la\nrm -rf zz'), '执行 ls -la'],
    [
      '命令超过 60 字保留首尾，写明省略几个字',
      command(`${'x'.repeat(30)}${'y'.repeat(40)}`),
      `执行 ${'x'.repeat(30)}…（省略 10 字）…${'y'.repeat(30)}`,
    ],
    ['新写的文件', call({ display: { kind: 'file-change', path: 'a.txt' } }), '写入 a.txt'],
    ['改动的文件', call({ display: { kind: 'file-change', path: 'a.txt', removed: 'x', added: 'y' } }), '修改 a.txt'],
    ['没声明展示的写工具名', call(), '调用 zz_tool'],
    [
      '认不出的展示种类按没声明的写',
      call({ display: { kind: 'zz-fetch' } as unknown as ToolCallItem['display'] }),
      '调用 zz_tool',
    ],
    ['工具名里的控制符显示出来', call({ name: 'zz\x1b[31m' }), '调用 zz\\x1B[31m'],
    ['路径里的控制符显示出来', call({ display: { kind: 'file-change', path: 'a\x1b[2J.txt' } }), '写入 a\\x1B[2J.txt'],
    ['工具名里的换行写成转义', call({ name: 'zz\nx' }), '调用 zz\\x0Ax'],
    [
      '路径里的换行与制表符写成转义，不拆行',
      call({ display: { kind: 'file-change', path: 'a.txt\nb\tc' } }),
      '写入 a.txt\\x0Ab\\x09c',
    ],
    ['命令第一行里的制表符写成转义', command('ls\t-la'), '执行 ls\\x09-la'],
  ] as const)('%s', (_name, item, summary) => {
    expect(rendered(item).summary).toBe(summary);
  });
});

describe('终端工具调用的一行：状态', () => {
  it.each([
    ['正在生成', call({ status: 'generating' }), [], { text: '正在生成' }],
    ['运行中', call({ status: 'running' }), [], { text: '运行中' }],
    ['等你批准：醒目', call({ status: 'running', approvalId: 'ap-1' }), [], { text: '等你批准', tone: 'attention' }],
    [
      '批准了的照状态写',
      call({ status: 'running', approvalId: 'ap-1', settlement: settled('approved') }),
      [],
      { text: '运行中' },
    ],
    ['失败：危险色', call({ status: 'failed' }), [], { text: '失败', tone: 'danger' }],
    [
      '命令的退出码不为 0：写退出码，危险色',
      call({ status: 'failed', display: { kind: 'command', command: 'make', exitCode: 2 } }),
      [],
      { text: '退出码 2', tone: 'danger' },
    ],
    ['已停止', call({ status: 'aborted' }), [], { text: '已停止' }],
    ['没批准', call({ status: 'denied', approvalId: 'ap-1', settlement: settled('denied') }), [], { text: '没批准' }],
    ['完成：一分钟以内写到十分之一秒', call({ durationMs: 1_234 }), [], { text: '1.2 秒' }],
    ['完成：一分钟起写分与秒', call({ durationMs: 65_400 }), [], { text: '1 分 5 秒' }],
    ['转到后台、任务还在跑', call({ taskId: 'task-1', durationMs: 5 }), ['task-1'], { text: '转到后台 · 运行中' }],
    ['转到后台、任务结束了：照完成的写', call({ taskId: 'task-1', durationMs: 1_500 }), [], { text: '1.5 秒' }],
  ] as const)('%s', (_name, item, running, status) => {
    expect(rendered(item, [...running]).status).toEqual({ tone: undefined, ...status });
  });

  it('完成了、没有用时：不写状态', () => {
    expect(rendered(call()).status).toBeUndefined();
  });

  it('用时里的数字按给的语言写：小数点写逗号的语言写逗号', () => {
    const status = toolLine(call({ durationMs: 1_234 }), () => false, 'de').status;
    expect(status && resolveSource(status.text)).toBe('1,2 秒');
  });
});

describe('聊天区实际用的语言', () => {
  it('取本插件字典此刻选中的那种；译文不是合法的语言标签时按原文的语言', () => {
    expect(languageOf(resolveSource)).toBe('zh-CN');
    expect(languageOf(text => resolveText(text, ['en']))).toBe('en');
    expect(languageOf(() => '<不是语言标签>')).toBe('zh-CN');
  });
});

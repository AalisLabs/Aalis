import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { BoundTools, RegisteredTool } from '../../packages/api-tools/src/index.js';
import { CwdState } from '../../packages/plugin-tool-system/src/tools/cwd-state.js';
import { registerFileTools } from '../../packages/plugin-tool-system/src/tools/file.js';

// ════════════════════════════════════════════════════════════
// file_edit / file_read 的两类静默改坏与死胡同：
//
// 1. file_edit 曾用 `content.replace(oldText, newText)` 落盘——String.replace 的第二参
//    是**替换模式**，newText 里的 `$$` / `$&` / `` $` `` / `$'` 会被展开成别的内容，
//    写进文件的和模型给的不是同一份，且不报错。
// 2. 行尾归一（CRLF→LF）本只为定位，却原样写回：一次改一行的编辑把整篇文件行尾改掉，
//    diff 全红。
// 3. editedLines 用 `newContent.indexOf(newText)` 定位——newText 若是前文已出现过的片段，
//    行号会指到前面那处。
// 4. file_read 的 maxReadSize 闸在读取前且不看 startLine/endLine：错误提示让模型
//    「用 startLine/endLine 读部分内容」，模型照做后撞上同一个闸——死胡同。
// ════════════════════════════════════════════════════════════

/** 内存 storage：只实现 file_* 用到的几个方法 */
function memoryStorage(files: Record<string, string>) {
  return {
    listRoots: () => [{ name: 'workspace', readable: true }],
    stat: async (uri: string) => {
      const data = files[uri];
      if (data === undefined) throw new Error(`不存在: ${uri}`);
      return { isDirectory: false, size: Buffer.byteLength(data, 'utf-8'), path: uri };
    },
    readFile: async (uri: string, encoding?: string) => {
      const data = files[uri];
      if (data === undefined) throw new Error(`不存在: ${uri}`);
      return encoding ? data : Buffer.from(data, 'utf-8');
    },
    writeFile: async (uri: string, data: string | Buffer) => {
      files[uri] = typeof data === 'string' ? data : data.toString('utf-8');
    },
    createReadStream: async (uri: string) => {
      const data = files[uri];
      if (data === undefined) throw new Error(`不存在: ${uri}`);
      return { stream: Readable.from([Buffer.from(data, 'utf-8')]), stat: { isDirectory: false } };
    },
  };
}

function setup(files: Record<string, string>, maxReadSize = 1048576) {
  const tools: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
  const svc: BoundTools = {
    register: (t: Omit<RegisteredTool, 'pluginName'>) => {
      tools[t.definition.function.name] = t;
      return () => undefined;
    },
    registerGroup: () => () => undefined,
    current: undefined,
    follow: () => () => undefined,
  };
  registerFileTools(svc, {
    maxReadSize,
    maxSearchBytes: 1048576,
    maxWriteSize: 10485760,
    allowedRoots: ['workspace'],
    storage: memoryStorage(files) as never,
    cwdState: new CwdState('workspace:/'),
  } as never);
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await tools[name].handler(args, { sessionId: 's1' } as never)) as string);
  return { call, files };
}

describe('file_edit：newText 按字面写入，不当替换模式展开', () => {
  // 这四个序列是 String.replace 的全部无捕获组替换模式；`$1`/`$@` 等不受影响，
  // 故只有这四条能抓住 bug——测别的序列会得到「恒绿」的假安全。
  const cases: Array<[string, string]> = [
    ['$$ 转义美元号', 'const price = "$$10"'],
    ['$& 整段匹配', 'log("$& matched")'],
    ['$` 匹配前文本', 'log("$` before")'],
    ["$' 匹配后文本", 'log("$\' after")'],
  ];

  for (const [label, newText] of cases) {
    it(`${label} 原样落盘`, async () => {
      const files = { 'workspace:/a.ts': 'head\nOLD\ntail\n' };
      const { call } = setup(files);
      const r = await call('file_edit', { path: 'workspace:/a.ts', oldText: 'OLD', newText });
      expect(r.error).toBeUndefined();
      expect(files['workspace:/a.ts']).toBe(`head\n${newText}\ntail\n`);
    });
  }
});

describe('file_edit：行尾与行号', () => {
  it('CRLF 文件改一行，其余行的行尾不变', async () => {
    const files = { 'workspace:/crlf.txt': 'a\r\nOLD\r\nc\r\nd\r\n' };
    const { call } = setup(files);
    const r = await call('file_edit', { path: 'workspace:/crlf.txt', oldText: 'OLD', newText: 'NEW' });
    expect(r.error).toBeUndefined();
    expect(files['workspace:/crlf.txt']).toBe('a\r\nNEW\r\nc\r\nd\r\n');
  });

  it('LF 文件不会被塞进 CR', async () => {
    const files = { 'workspace:/lf.txt': 'a\nOLD\nc\n' };
    const { call } = setup(files);
    await call('file_edit', { path: 'workspace:/lf.txt', oldText: 'OLD', newText: 'NEW' });
    expect(files['workspace:/lf.txt']).toBe('a\nNEW\nc\n');
  });

  it('混合行尾：只改命中的那一段，其它行的行尾原样保留', async () => {
    const files = { 'workspace:/mixed.txt': 'a\r\nb\nOLD\nd\r\n' };
    const { call } = setup(files);
    await call('file_edit', { path: 'workspace:/mixed.txt', oldText: 'OLD', newText: 'NEW' });
    expect(files['workspace:/mixed.txt']).toBe('a\r\nb\nNEW\nd\r\n');
    // 命中的是 CRLF 行：多行 newText 按 CRLF 写入，LF 行仍不动
    await call('file_edit', { path: 'workspace:/mixed.txt', oldText: 'a', newText: 'X\nY' });
    expect(files['workspace:/mixed.txt']).toBe('X\r\nY\r\nb\nNEW\nd\r\n');
  });

  it('oldText 用 CRLF 写、文件是 LF：照样命中，newText 按 LF 写入', async () => {
    const files = { 'workspace:/lf2.txt': 'a\nOLD\nc\n' };
    const { call } = setup(files);
    const r = await call('file_edit', { path: 'workspace:/lf2.txt', oldText: 'OLD\r\nc', newText: 'NEW\r\nZ' });
    expect(r.error).toBeUndefined();
    expect(files['workspace:/lf2.txt']).toBe('a\nNEW\nZ\n');
  });

  it('newText 是前文出现过的片段时，editedLines 仍指向真正的改动处', async () => {
    // 「foo」在第 1 行已出现：按 indexOf(newText) 定位会得出 start=1
    const files = { 'workspace:/dup.ts': 'foo\nbar\nbaz\nMARK\n' };
    const { call } = setup(files);
    const r = await call('file_edit', { path: 'workspace:/dup.ts', oldText: 'MARK', newText: 'foo' });
    expect(r.editedLines).toEqual({ start: 4, count: 1 });
  });
});

describe('file_read：超限文件给了行范围仍可读', () => {
  const big = Array.from({ length: 500 }, (_, i) => `line-${i + 1}`).join('\n');

  it('不给行范围 → 仍按 maxReadSize 拦下', async () => {
    const { call } = setup({ 'workspace:/big.log': big }, 64);
    const r = await call('file_read', { path: 'workspace:/big.log' });
    expect(r.error).toMatch(/文件过大/);
    expect(r.content).toBeUndefined();
  });

  it('给了行范围 → 按行流式读，不再撞闸', async () => {
    const { call } = setup({ 'workspace:/big.log': big }, 64);
    const r = await call('file_read', { path: 'workspace:/big.log', startLine: 100, endLine: 103 });
    expect(r.error).toBeUndefined();
    expect(r.startLine).toBe(100);
    expect(r.endLine).toBe(103);
    expect(r.content).toBe('100\tline-100\n101\tline-101\n102\tline-102\n103\tline-103');
  });

  it('行范围内容超过字节上限 → 截断并给出提示，而非报错', async () => {
    const { call } = setup({ 'workspace:/big.log': big }, 30);
    const r = await call('file_read', { path: 'workspace:/big.log', startLine: 1, endLine: 500 });
    expect(r.error).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.endLine).toBeLessThan(500);
  });

  it('单行本身超过上限 → 按字节截断返回该行并说明，而非空内容加无效建议', async () => {
    const files = { 'workspace:/min.js': `${'x'.repeat(5000)}\n` };
    const { call } = setup(files, 100);
    const r = await call('file_read', { path: 'workspace:/min.js', startLine: 1, endLine: 1 });
    expect(r.error).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.content).toBe(`1\t${'x'.repeat(100)}`);
    expect(r.advice).toContain('第 1 行本身超过');
  });

  it('小文件按行范围读时仍给出准确 totalLines', async () => {
    const { call } = setup({ 'workspace:/small.txt': 'a\nb\nc\nd' });
    const r = await call('file_read', { path: 'workspace:/small.txt', startLine: 2, endLine: 3 });
    expect(r.totalLines).toBe(4);
    expect(r.content).toBe('2\tb\n3\tc');
  });
});

describe('file_read：整篇与行范围两条路径同一行数口径', () => {
  it('结尾换行不算多一行：整篇 totalLines / endLine 与行范围一致', async () => {
    const { call } = setup({ 'workspace:/nl.txt': 'a\nb\n' });
    const whole = await call('file_read', { path: 'workspace:/nl.txt' });
    const ranged = await call('file_read', { path: 'workspace:/nl.txt', startLine: 1, endLine: 10 });
    expect(ranged.totalLines).toBe(2);
    expect(whole.totalLines).toBe(2);
    expect(whole.endLine).toBe(2);
    expect(whole.content).toBe('1\ta\n2\tb');
  });

  it('CRLF 文件整篇读：行内容不带 \\r，行数与行范围一致', async () => {
    const { call } = setup({ 'workspace:/crlf.txt': 'a\r\nb\r\nc' });
    const whole = await call('file_read', { path: 'workspace:/crlf.txt' });
    const ranged = await call('file_read', { path: 'workspace:/crlf.txt', startLine: 1, endLine: 10 });
    expect(whole.totalLines).toBe(3);
    expect(ranged.totalLines).toBe(3);
    expect(whole.content).toBe('1\ta\n2\tb\n3\tc');
    expect(ranged.content).toBe('1\ta\n2\tb\n3\tc');
  });

  it('空文件：整篇与行范围都是 0 行（此前整篇会报 1 行、内容为一个空行）', async () => {
    const { call } = setup({ 'workspace:/empty.txt': '' });
    const whole = await call('file_read', { path: 'workspace:/empty.txt' });
    const ranged = await call('file_read', { path: 'workspace:/empty.txt', startLine: 1, endLine: 10 });
    expect(whole.totalLines).toBe(0);
    expect(whole.endLine).toBe(0);
    expect(whole.content).toBe('');
    expect(ranged.totalLines).toBe(0);
    expect(ranged.content).toBe('');
  });
});

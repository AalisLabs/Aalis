import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoundTools, RegisteredTool } from '../../packages/api-tools/src/index.js';
import { CwdState } from '../../packages/plugin-tool-system/src/tools/cwd-state.js';
import { registerFileTools } from '../../packages/plugin-tool-system/src/tools/file.js';

// ════════════════════════════════════════════════════════════
// file_* 三处「成功回执下的破坏」：
//
// 1. 无锁读—改—写：agent 同一轮把 tool call 丢进 Promise.all，两次改同一文件各读到
//    同一份原文、后写者盖掉前写者，两边都回「成功」——丢一次改动。
// 2. file_append 把「读原文失败」吞成空串再整篇写回：原文被静默截断成只剩追加部分。
// 3. file_search 的 isRegex 直接 new RegExp 模型给的模式：`(a+)+$` 这类嵌套量词同步
//    回溯，超时与 abort 都打不断，整进程冻死。
// 4. file_search 目录模式的续搜：截断后要能从断点原地接着扫，不重复也不遗漏。
// ════════════════════════════════════════════════════════════

/**
 * 真 fs 后端的 storage：只实现 file_* 用到的方法。
 * unreadable / ioFailing 里的 URI 模拟读失败的两类非 ENOENT 错误（不可读的根 / 瞬时 IO 错）。
 */
function fsStorage(base: string, unreadable: Set<string>, ioFailing: Set<string>) {
  const toPath = (uri: string) => join(base, uri.replace(/^workspace:\//, ''));
  return {
    listRoots: () => [{ name: 'workspace', readable: true, writable: true }],
    stat: async (uri: string) => {
      const st = await stat(toPath(uri));
      return { isDirectory: st.isDirectory(), size: st.size, path: uri };
    },
    readFile: async (uri: string, encoding?: string) => {
      if (unreadable.has(uri)) throw new Error(`EACCES: permission denied, open '${uri}'`);
      if (ioFailing.has(uri)) throw new Error(`EIO: i/o error, read '${uri}'`);
      const buf = await readFile(toPath(uri));
      return encoding ? buf.toString('utf-8') : buf;
    },
    writeFile: async (uri: string, data: string | Buffer) => {
      await writeFile(toPath(uri), data);
    },
    delete: async (uri: string) => {
      await rm(toPath(uri), { recursive: true, force: true });
    },
    move: async (from: string, to: string) => {
      await rename(toPath(from), toPath(to));
      return to;
    },
    createReadStream: async (uri: string) => {
      // file_read / file_search 走的是这个口子，同样要认「存在但读不出来」
      if (unreadable.has(uri)) throw new Error(`EACCES: permission denied, open '${uri}'`);
      if (ioFailing.has(uri)) throw new Error(`EIO: i/o error, read '${uri}'`);
      return { stream: createReadStream(toPath(uri)), stat: { isDirectory: false } };
    },
    list: async (uri: string) => {
      const dir = uri.endsWith('/') ? uri.slice(0, -1) : uri;
      const dirents = await readdir(toPath(uri), { withFileTypes: true });
      return {
        entries: dirents.map(d => ({ name: d.name, uri: `${dir}/${d.name}`, isDirectory: d.isDirectory() })),
      };
    },
  };
}

let base: string;
let unreadable: Set<string>;
let ioFailing: Set<string>;
let call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aalis-file-safety-'));
  unreadable = new Set<string>();
  ioFailing = new Set<string>();
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
    maxReadSize: 1048576,
    maxSearchBytes: 1048576,
    maxWriteSize: 10485760,
    allowedRoots: ['workspace'],
    storage: fsStorage(base, unreadable, ioFailing) as never,
    cwdState: new CwdState('workspace:/'),
  } as never);
  call = async (name, args) => JSON.parse((await tools[name].handler(args, { sessionId: 's1' } as never)) as string);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const diskText = (name: string) => readFileSync(join(base, name), 'utf-8');

describe('改动类工具按 storage URI 串行：并发改同一文件不丢改动', () => {
  it('两次并发 file_edit 同一文件：两处改动都落盘', async () => {
    writeFileSync(join(base, 'a.ts'), 'head\nAAA\nBBB\ntail\n');
    const [r1, r2] = await Promise.all([
      call('file_edit', { path: 'workspace:/a.ts', oldText: 'AAA', newText: 'A1' }),
      call('file_edit', { path: 'workspace:/a.ts', oldText: 'BBB', newText: 'B1' }),
    ]);
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(diskText('a.ts')).toBe('head\nA1\nB1\ntail\n');
  });

  it('两次并发 file_append 同一文件：两段内容都在，原文不丢', async () => {
    writeFileSync(join(base, 'log.txt'), 'orig\n');
    const [r1, r2] = await Promise.all([
      call('file_append', { path: 'workspace:/log.txt', content: 'x\n' }),
      call('file_append', { path: 'workspace:/log.txt', content: 'y\n' }),
    ]);
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    const text = diskText('log.txt');
    expect(text.startsWith('orig\n')).toBe(true);
    expect(text).toContain('x\n');
    expect(text).toContain('y\n');
    expect(text.length).toBe('orig\nx\ny\n'.length);
  });

  it('file_edit 与 file_write 并发：write 不落在 edit 的读与写之间', async () => {
    writeFileSync(join(base, 'b.ts'), 'keep\nOLD\n');
    const [r1, r2] = await Promise.all([
      call('file_edit', { path: 'workspace:/b.ts', oldText: 'OLD', newText: 'NEW' }),
      call('file_write', { path: 'workspace:/b.ts', content: 'whole\n' }),
    ]);
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    // 先到先排队：edit 整段走完后 write 才整篇覆盖，落盘就是 write 的内容。
    // 无闸时 edit 的写会跑在 write 之后，把 write 的内容静默吞掉（两边仍都回成功）。
    expect(diskText('b.ts')).toBe('whole\n');
  });
});

describe('file_search 目录模式：读不出来的文件不得被静默跳过', () => {
  // 跳过此前完全无痕：该文件一行未扫，返回体却照常给 matchCount、truncated 仍为 false，
  // 模型拿着这个「非截断」的可信信号断言「不存在」。
  it('跳过的文件被计数并写进 advice，命中集只来自读得到的文件', async () => {
    mkdirSync(join(base, 'dir'), { recursive: true });
    writeFileSync(join(base, 'dir/ok.txt'), 'needle here\n');
    writeFileSync(join(base, 'dir/blocked.txt'), 'needle there\n');
    unreadable.add('workspace:/dir/blocked.txt');

    const r = await call('file_search', { path: 'workspace:/dir', pattern: 'needle' });

    expect(r.skippedFiles, '读不出来的文件必须被计数').toBe(1);
    expect(r.matchCount, '只应有读得到的那个文件的命中').toBe(1);
    expect(String(r.advice ?? ''), '要明确提示别据此断言找不到').toMatch(/未能读取|不要根据本次结果断言/);
  });

  it('全部可读时不出现 skippedFiles 字段', async () => {
    mkdirSync(join(base, 'clean'), { recursive: true });
    writeFileSync(join(base, 'clean/a.txt'), 'needle\n');
    const r = await call('file_search', { path: 'workspace:/clean', pattern: 'needle' });
    expect(r.skippedFiles).toBeUndefined();
    expect(r.matchCount).toBe(1);
  });
});

describe('file_append：读原文失败不当空串', () => {
  it('读原文失败（存在但不可读）→ 报错，原文一字不动', async () => {
    writeFileSync(join(base, 'c.md'), 'l1\nl2\nl3\n');
    unreadable.add('workspace:/c.md');
    const r = await call('file_append', { path: 'workspace:/c.md', content: 'l4\n' });
    expect(r.error).toMatch(/EACCES/);
    expect(r.message).toBeUndefined();
    expect(diskText('c.md')).toBe('l1\nl2\nl3\n');
  });

  it('read 以非 ENOENT 失败（瞬时 IO 错）→ 不截断、报错，不当成新建', async () => {
    writeFileSync(join(base, 'd.md'), 'k1\nk2\nk3\n');
    ioFailing.add('workspace:/d.md');
    const r = await call('file_append', { path: 'workspace:/d.md', content: 'k4\n' });
    expect(r.error).toMatch(/EIO/);
    expect(r.message).toBeUndefined();
    expect(diskText('d.md')).toBe('k1\nk2\nk3\n');
  });

  it('文件不存在 → 仍按创建处理', async () => {
    const r = await call('file_append', { path: 'workspace:/new.md', content: 'first\n' });
    expect(r.error).toBeUndefined();
    expect(diskText('new.md')).toBe('first\n');
  });
});

describe('file_search：isRegex 的模式体检', () => {
  it('嵌套量词（(a+)+$）被拒，不进入灾难性回溯', async () => {
    // 样本刻意只 24 个 a：未体检时这一行的回溯已够让用例直接红（实测 ~2s），
    // 而 n≈32 时整个 vitest worker 被同步回溯冻住，连 testTimeout 都打不断（跑过 120s 无输出）
    writeFileSync(join(base, 'evil.txt'), `${'a'.repeat(24)}b\n`);
    const r = await call('file_search', { path: 'workspace:/evil.txt', pattern: '(a+)+$', isRegex: true });
    expect(r.error).toMatch(/嵌套量词|回溯/);
    expect(r.matches).toBeUndefined();
  });

  it('嵌套量词隔一层也被拒：((a+)a)+$', async () => {
    // 子分组的危险标记若不向父层传播，这个模式会漏检；样本同样只 24 个 a（够让漏检直接红）
    writeFileSync(join(base, 'evil3.txt'), `${'a'.repeat(24)}b\n`);
    const r = await call('file_search', { path: 'workspace:/evil3.txt', pattern: '((a+)a)+$', isRegex: true });
    expect(r.error).toMatch(/嵌套量词|回溯/);
    expect(r.matches).toBeUndefined();
  });

  it('无界量词堆叠过多被拒：a+a+a+a+a+a+b', async () => {
    writeFileSync(join(base, 'stack.txt'), `${'a'.repeat(24)}b\n`);
    const r = await call('file_search', { path: 'workspace:/stack.txt', pattern: 'a+a+a+a+a+a+b', isRegex: true });
    expect(r.error).toMatch(/无界量词过多/);
    expect(r.matches).toBeUndefined();
  });

  it('{n,} 也算无界：堆六个同样被拒', async () => {
    writeFileSync(join(base, 'stack2.txt'), 'abcdef\n');
    const r = await call('file_search', {
      path: 'workspace:/stack2.txt',
      pattern: 'a{1,}b{1,}c{1,}d{1,}e{1,}f{1,}',
      isRegex: true,
    });
    expect(r.error).toMatch(/无界量词过多/);
  });

  it('含量词的分支重复（(a+|b)*）同样被拒', async () => {
    writeFileSync(join(base, 'evil2.txt'), `${'a'.repeat(24)}c\n`);
    const r = await call('file_search', { path: 'workspace:/evil2.txt', pattern: '(a+|b)*$', isRegex: true });
    expect(r.error).toMatch(/嵌套量词|回溯/);
  });

  it('重叠分支的重复（(a|a)+$）被拒：内部无量词，分支本身就是危险标记', async () => {
    writeFileSync(join(base, 'evil4.txt'), `${'a'.repeat(24)}b\n`);
    const r = await call('file_search', { path: 'workspace:/evil4.txt', pattern: '(a|a)+$', isRegex: true });
    expect(r.error).toMatch(/嵌套量词|回溯/);
    expect(r.matches).toBeUndefined();
  });

  it('量词堆叠过多被拒', async () => {
    writeFileSync(join(base, 'q.txt'), 'aaaa\n');
    const r = await call('file_search', { path: 'workspace:/q.txt', pattern: `${'x?'.repeat(25)}y`, isRegex: true });
    expect(r.error).toMatch(/量词过多/);
  });

  const ok: Array<[string, string]> = [
    ['锚点 + 通配', '^import .*from'],
    ['字符类 + 单层量词', '[A-Za-z_]+\\('],
    ['有界量词', '\\d{4}-\\d{2}-\\d{2}'],
    ['未加量词的分组与分支', '(TODO|FIXME):'],
    ['分组加量词、内部无量词', '(ab)+'],
    ['可选分组', '(\\w+)?end'],
    // 无界量词上限 5：这几条 3 个、2 个、5 个（正好抵上限），都是日常搜索的常态写法，必须放行
    ['多个通配段', '.*foo.*bar.*'],
    ['行注释', '^\\s*//.*$'],
    ['无界量词正好 5 个', '.*a.*b.*c.*d.*'],
    // 有上限的 {n} / {n,m} 不进无界计数：时间戳这种六个 {n} 的常态模式不能被误拒
    ['多个有界量词', '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}'],
    // 嵌套但内部全有界：重复次数封顶为常数，回溯撑不到指数级，不能被误拒
    ['全有界嵌套（IPv4）', '(?:[0-9]{1,3}\\.){3}[0-9]{1,3}'],
    ['全有界嵌套（时分秒）', '(\\d{2}:){3}'],
    ['全有界嵌套（最小形）', '(a{2}){3}'],
  ];
  for (const [label, pattern] of ok) {
    it(`常见模式照常放行：${label}`, async () => {
      writeFileSync(
        join(base, 'src.ts'),
        'import { x } from "y"\nfoo(bar)\n2026-09-12T10:20:30\nTODO: t\nababend\n  // note a b c d\n192.168.1.1 10:20:30:40 aaaaaa\n',
      );
      const r = await call('file_search', { path: 'workspace:/src.ts', pattern, isRegex: true });
      expect(r.error).toBeUndefined();
      expect(Array.isArray(r.matches)).toBe(true);
      expect((r.matches as unknown[]).length).toBeGreaterThan(0);
    });
  }

  it('纯文本搜索不受体检影响：pattern 里的 (a+)+ 按字面找', async () => {
    writeFileSync(join(base, 'lit.txt'), 'pattern (a+)+ here\n');
    const r = await call('file_search', { path: 'workspace:/lit.txt', pattern: '(a+)+' });
    expect(r.error).toBeUndefined();
    expect((r.matches as Array<{ line: number }>).length).toBe(1);
  });
});

describe('file_search 目录模式：截断后按 nextStartFile + nextStartLine 续搜', () => {
  /** 反复调用直到不再截断，把命中按顺序摊平成 `<相对路径>:<行号>`，并记下每一跳的断点 */
  async function drain(dir: string, args: Record<string, unknown>) {
    const hits: string[] = [];
    const breakpoints: Array<{ file: string; line: number }> = [];
    let startFile: string | undefined;
    let startLine: number | undefined;
    for (let round = 0; round < 60; round++) {
      const r = await call('file_search', {
        path: dir,
        pattern: 'hit',
        ...args,
        ...(startFile ? { startFile, startLine } : {}),
      });
      expect(r.error).toBeUndefined();
      for (const m of r.matches as Array<{ uri: string; line: number }>) {
        hits.push(`${m.uri.slice(`${dir}/`.length)}:${m.line}`);
      }
      if (!r.truncated) return { hits, breakpoints };
      expect(typeof r.nextStartFile).toBe('string');
      expect(typeof r.nextStartLine).toBe('number');
      expect(r.advice).toContain(`startFile=${r.nextStartFile}, startLine=${r.nextStartLine}`);
      // 断点只对同一组检索参数有效：advice 必须点名要原样重传的那几个
      expect(r.advice).toContain('pattern / isRegex / ignoreCase / exclude / include 原样重传');
      startFile = r.nextStartFile as string;
      startLine = r.nextStartLine as number;
      breakpoints.push({ file: startFile, line: startLine });
    }
    throw new Error('续搜未收敛');
  }

  it('maxResults 耗尽：断点=同文件最后一条命中行 +1，续搜零重复零遗漏', async () => {
    // 遍历序由 collectFiles 定：目录优先、字典序 → sub/d.txt, a.txt, b.txt, c.txt
    mkdirSync(join(base, 'dir', 'sub'), { recursive: true });
    writeFileSync(join(base, 'dir', 'sub', 'd.txt'), 'hit 1\nx\nhit 2\n');
    writeFileSync(join(base, 'dir', 'a.txt'), 'hit a1\nhit a2\nx\nhit a3\n');
    writeFileSync(join(base, 'dir', 'b.txt'), 'x\nhit b1\n');
    writeFileSync(join(base, 'dir', 'c.txt'), 'nothing here\n');

    const one = await call('file_search', { path: 'workspace:/dir', pattern: 'hit', maxResults: 2 });
    expect(one.truncated).toBe(true);
    // 第一段只吃到 sub/d.txt 的两条命中，断点落在同文件的下一行（3 + 1）
    expect(one.nextStartFile).toBe('sub/d.txt');
    expect(one.nextStartLine).toBe(4);

    const { hits } = await drain('workspace:/dir', { maxResults: 2 });
    expect(hits).toEqual(['sub/d.txt:1', 'sub/d.txt:3', 'a.txt:1', 'a.txt:2', 'a.txt:4', 'b.txt:2']);
    expect(new Set(hits).size).toBe(hits.length);
  });

  it('maxSearchBytes 中途耗尽：断点=同文件最后扫描行 +1，续搜零重复零遗漏', async () => {
    // 每行 ~66 字节 × 40 行 ≈ 2.6KB，配 1024 字节预算 → 必然停在 big.txt 中途
    mkdirSync(join(base, 'dir2'), { recursive: true });
    const big = Array.from({ length: 40 }, (_, i) => `hit ${'y'.repeat(58)} ${i + 1}`).join('\n');
    writeFileSync(join(base, 'dir2', 'big.txt'), `${big}\n`);
    writeFileSync(join(base, 'dir2', 'tail.txt'), 'x\nhit tail\n');

    const one = await call('file_search', { path: 'workspace:/dir2', pattern: 'hit', maxSearchBytes: 1024 });
    expect(one.truncated).toBe(true);
    expect(one.nextStartFile).toBe('big.txt');
    // 停在文件中途：断点行号 = 本次最后扫描行 +1，正好接着上次的最后一条命中
    const firstBatch = one.matches as Array<{ line: number }>;
    expect(firstBatch.length).toBeGreaterThan(0);
    expect(firstBatch.length).toBeLessThan(40);
    expect(one.nextStartLine).toBe(firstBatch[firstBatch.length - 1].line + 1);

    const { hits } = await drain('workspace:/dir2', { maxSearchBytes: 1024 });
    expect(hits).toEqual([...Array.from({ length: 40 }, (_, i) => `big.txt:${i + 1}`), 'tail.txt:2']);
    expect(new Set(hits).size).toBe(hits.length);
  });

  it('startFile 不在该目录下 → 直接报错，不静默从头重扫', async () => {
    mkdirSync(join(base, 'dir3'), { recursive: true });
    writeFileSync(join(base, 'dir3', 'a.txt'), 'hit\n');
    const r = await call('file_search', { path: 'workspace:/dir3', pattern: 'hit', startFile: 'nope.txt' });
    expect(r.error).toMatch(/startFile/);
    // 最常见的成因是续搜漏传 exclude/include 把断点文件排除掉了，错误里要说出来
    expect(r.error).toMatch(/exclude/);
    expect(r.matches).toBeUndefined();
  });
});

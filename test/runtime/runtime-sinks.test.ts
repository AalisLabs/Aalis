import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultLogger } from '@aalis/core';
import { parseLogLine } from '@aalis/schema-log';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetBootstrapBufferForTests,
  getBootstrapBuffer,
  installBootstrapBuffer,
} from '../../packages/runtime/src/bootstrap-buffer.js';
import { installConsoleSink } from '../../packages/runtime/src/console-sink.js';
import { appendCrashLog, setupFileLogger } from '../../packages/runtime/src/file-logger.js';

/**
 * runtime/console-sink + file-logger 集成测试
 */

describe('runtime console-sink', () => {
  let originalLog: typeof console.log;
  let captured: string[];
  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
  });
  afterEach(() => {
    console.log = originalLog;
  });

  it('installConsoleSink 接管输出后 Logger.info 走 console.log', () => {
    const handle = installConsoleSink();
    try {
      new DefaultLogger('runtime-test').info('hello-from-runtime');
      expect(captured.some(line => line.includes('hello-from-runtime'))).toBe(true);
      expect(captured.some(line => line.includes('runtime-test'))).toBe(true);
      expect(typeof handle.colorized).toBe('boolean');
    } finally {
      handle.dispose();
    }
  });

  it("target: 'stderr' 时走 console.error，不碰 console.log（子命令模式把 stdout 留给命令结果）", () => {
    const errCaptured: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errCaptured.push(args.map(String).join(' '));
    };
    const handle = installConsoleSink({ target: 'stderr' });
    try {
      new DefaultLogger('runtime-test').info('to-stderr');
      expect(errCaptured.some(line => line.includes('to-stderr'))).toBe(true);
      expect(captured.some(line => line.includes('to-stderr'))).toBe(false);
    } finally {
      handle.dispose();
      console.error = originalError;
    }
  });

  it('dispose 后不再转发新日志', () => {
    const handle = installConsoleSink();
    handle.dispose();
    captured.length = 0;
    new DefaultLogger('after-dispose').info('should-not-appear');
    expect(captured.some(line => line.includes('should-not-appear'))).toBe(false);
  });

  it('启动前缓冲会被冲洗（依赖 bootstrap-buffer）', () => {
    installBootstrapBuffer();
    try {
      new DefaultLogger('preboot').info('msg-before-sink');
      const handle = installConsoleSink();
      try {
        expect(captured.some(line => line.includes('msg-before-sink'))).toBe(true);
      } finally {
        handle.dispose();
      }
    } finally {
      __resetBootstrapBufferForTests();
    }
  });
});

describe('runtime bootstrap-buffer', () => {
  afterEach(() => {
    __resetBootstrapBufferForTests();
  });

  it('snapshot 多次可重复读取，互相独立副本', () => {
    const handle = installBootstrapBuffer();
    new DefaultLogger('boot').info('first');
    const s1 = handle.snapshot();
    new DefaultLogger('boot').info('second');
    const s2 = handle.snapshot();
    expect(s1.map(e => e.message)).toEqual(['first']);
    expect(s2.map(e => e.message)).toEqual(['first', 'second']);
    // s1 与 s2 是不同数组（副本语义）
    expect(s1).not.toBe(s2);
  });

  it('dispose 后不再收集新条目', () => {
    const handle = installBootstrapBuffer();
    new DefaultLogger('boot').info('before-dispose');
    handle.dispose();
    new DefaultLogger('boot').info('after-dispose');
    // dispose 后 snapshot 已清空
    expect(handle.snapshot()).toEqual([]);
  });

  it('未安装时 getBootstrapBuffer 返回空 stub（不抛错）', () => {
    const stub = getBootstrapBuffer();
    expect(stub.snapshot()).toEqual([]);
    expect(() => stub.dispose()).not.toThrow();
  });

  it('重复 install 返回同一实例（幂等）', () => {
    const a = installBootstrapBuffer();
    const b = installBootstrapBuffer();
    expect(a).toBe(b);
  });
});

describe('runtime file-logger', () => {
  let dir: string;
  let logFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aalis-flog-'));
    logFile = join(dir, 'latest.log');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('setupFileLogger 记录后续日志到文件', async () => {
    const handle = await setupFileLogger(logFile);
    try {
      new DefaultLogger('flog').warn('later-msg');
      new DefaultLogger('flog').info('another');
      await handle.flush();
      // 追加是异步队列，再给一个 microtask 并 flush
      await new Promise(r => setImmediate(r));
      await handle.flush();
      const content = readFileSync(logFile, 'utf-8');
      const entries = content.split('\n').filter(Boolean).map(parseLogLine);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scope: 'flog', level: 'warn', message: 'later-msg' }),
          expect.objectContaining({ scope: 'flog', level: 'info', message: 'another' }),
        ]),
      );
    } finally {
      await handle.dispose();
    }
  });

  it('换行被转义为字面 \\n', async () => {
    const handle = await setupFileLogger(logFile);
    try {
      new DefaultLogger('flog').error('line1\nline2');
      await handle.flush();
      await new Promise(r => setImmediate(r));
      await handle.flush();
      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('line1\\nline2');
      // 同一条日志只占一行
      const errLines = content.split('\n').filter(l => l.includes('line1'));
      expect(errLines.length).toBe(1);
    } finally {
      await handle.dispose();
    }
  });

  it('appendCrashLog 写入 Error 堆栈', async () => {
    const file = join(dir, 'crash.log');
    await appendCrashLog('test-crash', new Error('crashy'), file);
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('test-crash');
    expect(content).toContain('crashy');
    expect(parseLogLine(content.trimEnd())?.level).toBe('error');
  });

  it('appendCrashLog 处理非 Error 值', async () => {
    const file = join(dir, 'crash.log');
    await appendCrashLog('s-crash', 'plain-string', file);
    await appendCrashLog('o-crash', { code: 42 }, file);
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('plain-string');
    expect(
      content
        .split('\n')
        .filter(Boolean)
        .map(parseLogLine)
        .some(entry => entry?.message.includes('"code":42')),
    ).toBe(true);
  });

  it('文件记录包含递增 seq，可被 parseLogLine 反解', async () => {
    const handle = await setupFileLogger(logFile);
    try {
      new DefaultLogger('flog').info('alpha');
      new DefaultLogger('flog').warn('beta');
      await handle.flush();
      await new Promise(r => setImmediate(r));
      await handle.flush();
      const lines = readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
      const entries = lines
        .map(parseLogLine)
        .filter((e): e is NonNullable<ReturnType<typeof parseLogLine>> => e !== null);
      expect(entries.length).toBeGreaterThanOrEqual(2);
      const a = entries.find(e => e.message === 'alpha');
      const b = entries.find(e => e.message === 'beta');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(b!.seq).toBeGreaterThan(a!.seq);
      expect(a!.level).toBe('info');
      expect(b!.level).toBe('warn');
    } finally {
      await handle.dispose();
    }
  });

  it('dispose 后退订：二次 setupFileLogger 不会让同一条日志写两遍', async () => {
    const first = await setupFileLogger(logFile);
    await first.dispose();
    const second = await setupFileLogger(logFile);
    try {
      new DefaultLogger('flog').info('only-once');
      await second.flush();
      await new Promise(r => setImmediate(r));
      await second.flush();
      const hits = readFileSync(logFile, 'utf-8')
        .split('\n')
        .filter(l => l.includes('only-once'));
      expect(hits.length).toBe(1);
    } finally {
      await second.dispose();
    }
  });

  // 启动时的日志轮转：上一轮改名为 latest.1.log，更早的依次后移，保留 5 份
  const historyFile = (n: number) => join(dir, `latest.${n}.log`);
  const readEntries = (file: string) =>
    readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(parseLogLine)
      .filter((e): e is NonNullable<ReturnType<typeof parseLogLine>> => e !== null);

  it('首次启动没有旧日志：照常新建 latest.log，不产生历史文件，也不告警', async () => {
    const handle = await setupFileLogger(logFile);
    try {
      new DefaultLogger('flog').info('fresh-start');
      await handle.flush();
      await new Promise(r => setImmediate(r));
      await handle.flush();
      expect(readdirSync(dir)).toEqual(['latest.log']);
      const entries = readEntries(logFile);
      expect(entries.map(e => e.message)).toContain('fresh-start');
      expect(entries.filter(e => e.level === 'warn')).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it('上一轮改名为 latest.1.log，其余依次后移；只留 5 份，原 latest.5.log 被挤掉', async () => {
    writeFileSync(logFile, 'run-6\n');
    for (let n = 1; n <= 5; n++) writeFileSync(historyFile(n), `run-${6 - n}\n`);
    const handle = await setupFileLogger(logFile);
    await handle.dispose();
    expect(readdirSync(dir).sort()).toEqual([
      'latest.1.log',
      'latest.2.log',
      'latest.3.log',
      'latest.4.log',
      'latest.5.log',
      'latest.log',
    ]);
    for (let n = 1; n <= 5; n++) expect(readFileSync(historyFile(n), 'utf-8')).toBe(`run-${7 - n}\n`);
    // run-1 已被删除；新的 latest.log 不带任何一轮的旧内容
    expect(readFileSync(logFile, 'utf-8')).not.toContain('run-');
  });

  it('轮转失败不拦启动：告警写明原因，本轮照旧覆盖写（一个文件只装一轮），已有的历史不动', async () => {
    writeFileSync(logFile, 'prev-run\n');
    writeFileSync(historyFile(4), 'run-4\n');
    // latest.5.log 是目录：第一步 latest.4.log → latest.5.log 即失败（EISDIR），轮转停在这里
    mkdirSync(historyFile(5));
    writeFileSync(join(historyFile(5), 'keep'), 'x');
    const handle = await setupFileLogger(logFile);
    try {
      new DefaultLogger('flog').info('this-run');
      await handle.flush();
      await new Promise(r => setImmediate(r));
      await handle.flush();
      const content = readFileSync(logFile, 'utf-8');
      // 不接在上一轮后面写：读取方依赖 seq 随文件位置单调递增
      expect(content).not.toContain('prev-run');
      const warns = readEntries(logFile).filter(e => e.level === 'warn');
      expect(warns).toEqual([
        expect.objectContaining({ scope: 'aalis:runtime', message: expect.stringContaining('EISDIR') }),
      ]);
      expect(warns[0].message).toContain('上一轮的日志没能改名保留');
      expect(warns[0].message).toContain('覆盖写入');
      expect(content).toContain('this-run');
      expect(readFileSync(historyFile(4), 'utf-8')).toBe('run-4\n');
      expect(readFileSync(join(historyFile(5), 'keep'), 'utf-8')).toBe('x');
    } finally {
      await handle.dispose();
    }
  });
});

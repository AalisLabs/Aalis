import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, parseLogLine } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetBootstrapBufferForTests,
  getBootstrapBuffer,
  installBootstrapBuffer,
} from '../../src/runtime/bootstrap-buffer.js';
import { installConsoleSink } from '../../src/runtime/console-sink.js';
import { appendCrashLog, setupFileLogger } from '../../src/runtime/file-logger.js';

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
      new Logger('runtime-test').info('hello-from-runtime');
      expect(captured.some(line => line.includes('hello-from-runtime'))).toBe(true);
      expect(captured.some(line => line.includes('runtime-test'))).toBe(true);
      expect(typeof handle.colorized).toBe('boolean');
    } finally {
      handle.dispose();
    }
  });

  it('dispose 后不再转发新日志', () => {
    const handle = installConsoleSink();
    handle.dispose();
    captured.length = 0;
    new Logger('after-dispose').info('should-not-appear');
    expect(captured.some(line => line.includes('should-not-appear'))).toBe(false);
  });

  it('启动前缓冲会被冲洗（依赖 bootstrap-buffer）', () => {
    installBootstrapBuffer();
    try {
      new Logger('preboot').info('msg-before-sink');
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
    new Logger('boot').info('first');
    const s1 = handle.snapshot();
    new Logger('boot').info('second');
    const s2 = handle.snapshot();
    expect(s1.map(e => e.message)).toEqual(['first']);
    expect(s2.map(e => e.message)).toEqual(['first', 'second']);
    // s1 与 s2 是不同数组（副本语义）
    expect(s1).not.toBe(s2);
  });

  it('dispose 后不再收集新条目', () => {
    const handle = installBootstrapBuffer();
    new Logger('boot').info('before-dispose');
    handle.dispose();
    new Logger('boot').info('after-dispose');
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
    new Logger('flog').warn('later-msg');
    new Logger('flog').info('another');
    await handle.flush();
    // 追加是异步队列，再给一个 microtask 并 flush
    await new Promise(r => setImmediate(r));
    await handle.flush();
    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('later-msg');
    expect(content).toContain('another');
    expect(content).toContain('|warn|');
    expect(content).toContain('|info|');
  });

  it('换行被转义为字面 \\n', async () => {
    const handle = await setupFileLogger(logFile);
    new Logger('flog').error('line1\nline2');
    await handle.flush();
    await new Promise(r => setImmediate(r));
    await handle.flush();
    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('line1\\nline2');
    // 同一条日志只占一行
    const errLines = content.split('\n').filter(l => l.includes('line1'));
    expect(errLines.length).toBe(1);
  });

  it('appendCrashLog 写入 Error 堆栈', async () => {
    const file = join(dir, 'crash.log');
    await appendCrashLog('test-crash', new Error('crashy'), file);
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('test-crash');
    expect(content).toContain('crashy');
    expect(content).toContain('|error|');
  });

  it('appendCrashLog 处理非 Error 值', async () => {
    const file = join(dir, 'crash.log');
    await appendCrashLog('s-crash', 'plain-string', file);
    await appendCrashLog('o-crash', { code: 42 }, file);
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('plain-string');
    expect(content).toContain('"code":42');
  });

  it('文件行格式包含递增 seq 前缀，可被 parseLogLine 反解', async () => {
    const handle = await setupFileLogger(logFile);
    new Logger('flog').info('alpha');
    new Logger('flog').warn('beta');
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
  });
});

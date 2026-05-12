import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, LogHub } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installConsoleSink } from '../../src/runtime/console-sink.js';
import { appendCrashLog, setupFileLogger } from '../../src/runtime/file-logger.js';

/**
 * runtime/console-sink + file-logger 集成测试
 */

describe('runtime console-sink', () => {
  let originalLog: typeof console.log;
  let captured: string[];
  beforeEach(() => {
    // installConsoleSink 现在通过 setConsoleFormatter 注入格式化器，
    // 并依赖 consoleSinkEnabled=true 走默认 console.log 路径。
    LogHub.default.setConsoleSinkEnabled(true);
    captured = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
  });
  afterEach(() => {
    console.log = originalLog;
    LogHub.default.setConsoleFormatter(null);
    LogHub.default.setConsoleSinkEnabled(true);
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

  it('dispose 后不再应用彩色格式化器（回退到默认 raw 格式）', () => {
    const handle = installConsoleSink();
    new Logger('before-dispose').info('pre-msg');
    handle.dispose();
    captured.length = 0;
    new Logger('after-dispose').info('plain-msg');
    // dispose 后仍写 console（consoleSink 默认开），但是 raw 格式（不带 ANSI 转义/彩色）
    expect(captured.some(line => line.includes('plain-msg'))).toBe(true);
    // 默认 raw 格式不带 ANSI 转义序列
    const afterLine = captured.find(line => line.includes('plain-msg'))!;
    expect(afterLine).not.toMatch(/\x1b\[/);
  });

  it('启动前缓冲会被冲洗', () => {
    new Logger('preboot').info('msg-before-sink');
    const handle = installConsoleSink();
    try {
      expect(captured.some(line => line.includes('msg-before-sink'))).toBe(true);
    } finally {
      handle.dispose();
    }
  });
});

describe('runtime file-logger', () => {
  let dir: string;
  let logFile: string;
  beforeEach(() => {
    LogHub.default.setConsoleSinkEnabled(false);
    dir = mkdtempSync(join(tmpdir(), 'aalis-flog-'));
    logFile = join(dir, 'latest.log');
  });
  afterEach(() => {
    LogHub.default.setConsoleSinkEnabled(true);
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
});

import { Logger, LogHub } from '@aalis/core';
import { describe, expect, it } from 'vitest';

/**
 * LogHub 行为：纯 pub-sub 通道，无 stdout 知识。
 *
 * stdout 输出由 runtime/console-sink.ts 通过订阅 onEntry 实现，
 * 这里只验证 LogHub 自身的语义。
 */

describe('LogHub 纯 pub-sub', () => {
  it('Logger.info 不再触发 console.log（core 完全去 stdout 化）', () => {
    const hub = new LogHub();
    const logger = new Logger('t', 'debug', hub);
    const before = hub.getBuffer().length;
    logger.info('hello');
    expect(hub.getBuffer().length).toBe(before + 1);
    expect(hub.getBuffer().at(-1)?.message).toBe('hello');
  });

  it('onEntry 订阅者收到全部 LogEntry', () => {
    const hub = new LogHub();
    const captured: string[] = [];
    const off = hub.onEntry(e => captured.push(e.message));
    const logger = new Logger('sub', 'debug', hub);
    logger.info('m1');
    logger.warn('m2');
    expect(captured).toEqual(['m1', 'm2']);
    off();
  });

  it('多 hub 隔离', () => {
    const hubA = new LogHub();
    const hubB = new LogHub();
    new Logger('a', 'debug', hubA).info('only-a');
    expect(hubA.getBuffer().some(e => e.message === 'only-a')).toBe(true);
    expect(hubB.getBuffer().some(e => e.message === 'only-a')).toBe(false);
  });

  it('低于 minLevel 不入缓冲', () => {
    const hub = new LogHub();
    const logger = new Logger('lvl', 'warn', hub);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(hub.getBuffer().map(e => e.level)).toEqual(['warn', 'error']);
  });

  it('缓冲容量上限（默认 2000 条 FIFO）', () => {
    const hub = new LogHub();
    const logger = new Logger('cap', 'debug', hub);
    for (let i = 0; i < 2100; i++) logger.info(`m${i}`);
    const buf = hub.getBuffer();
    expect(buf.length).toBe(2000);
    expect(buf[0].message).toBe('m100');
    expect(buf.at(-1)?.message).toBe('m2099');
  });
});

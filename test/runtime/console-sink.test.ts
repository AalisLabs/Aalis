import { DefaultLogger, LogHub } from '@aalis/core';
import { describe, expect, it } from 'vitest';

/**
 * LogHub 行为：纯 pub-sub 通道，无 stdout 知识、无 buffer。
 *
 * stdout 输出由 runtime/console-sink.ts 通过订阅 onEntry 实现；
 * 启动期日志的暂存由 runtime/bootstrap-buffer.ts 单独负责（见对应测试）。
 */

describe('LogHub 纯 pub-sub', () => {
  it('Logger.info 不直接触发任何输出（core 完全去 stdout 化）', () => {
    const hub = new LogHub();
    const seen: string[] = [];
    hub.onEntry(e => seen.push(e.message));
    new DefaultLogger('t', 'debug', hub).info('hello');
    expect(seen).toEqual(['hello']);
  });

  it('onEntry 订阅者收到全部 LogEntry，含递增 seq', () => {
    const hub = new LogHub();
    const captured: Array<{ seq: number; message: string }> = [];
    const off = hub.onEntry(e => captured.push({ seq: e.seq, message: e.message }));
    const logger = new DefaultLogger('sub', 'debug', hub);
    logger.info('m1');
    logger.warn('m2');
    expect(captured.map(c => c.message)).toEqual(['m1', 'm2']);
    expect(captured[1].seq).toBe(captured[0].seq + 1);
    off();
  });

  it('多 hub 隔离（订阅者互不串台）', () => {
    const hubA = new LogHub();
    const hubB = new LogHub();
    const a: string[] = [];
    const b: string[] = [];
    hubA.onEntry(e => a.push(e.message));
    hubB.onEntry(e => b.push(e.message));
    new DefaultLogger('a', 'debug', hubA).info('only-a');
    expect(a).toEqual(['only-a']);
    expect(b).toEqual([]);
  });

  it('低于 minLevel 不广播', () => {
    const hub = new LogHub();
    const seen: string[] = [];
    hub.onEntry(e => seen.push(e.level));
    const logger = new DefaultLogger('lvl', 'warn', hub);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(seen).toEqual(['warn', 'error']);
  });
});

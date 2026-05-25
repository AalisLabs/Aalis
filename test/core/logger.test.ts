import { describe, expect, it } from 'vitest';
import { Logger, LogHub } from '../../packages/core/src/index.js';

describe('LogHub', () => {
  it('Logger 写入 → LogHub.push → 触发 onEntry 监听器', () => {
    const hub = new LogHub();
    const captured: string[] = [];
    hub.onEntry(e => captured.push(`${e.level}:${e.scope}:${e.message}`));
    const log = new Logger('t', 'debug', hub);
    log.info('hello');
    log.warn('oops');
    expect(captured).toEqual(['info:t:hello', 'warn:t:oops']);
  });

  it('Logger.child 继承同一 hub 与 minLevel', () => {
    const hub = new LogHub();
    const seen: string[] = [];
    hub.onEntry(e => seen.push(e.scope));
    const root = new Logger('root', 'info', hub);
    const child = root.child('sub');
    child.info('x');
    expect(seen).toEqual(['root:sub']);
  });

  it('minLevel 低于阈值的日志被丢弃', () => {
    const hub = new LogHub();
    const seen: string[] = [];
    hub.onEntry(e => seen.push(e.level));
    const log = new Logger('t', 'warn', hub);
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(seen).toEqual(['warn', 'error']);
  });

  it('每个 LogHub 实例独立分配 seq（从 0 起单调递增）', () => {
    const hub = new LogHub();
    const seen: number[] = [];
    hub.onEntry(e => seen.push(e.seq));
    const log = new Logger('t', 'debug', hub);
    log.info('a');
    log.info('b');
    log.info('c');
    expect(seen).toEqual([0, 1, 2]);
  });

  it('allocSeq() 与 Logger.log 共用同一计数器', () => {
    const hub = new LogHub();
    expect(hub.allocSeq()).toBe(0);
    const seen: number[] = [];
    hub.onEntry(e => seen.push(e.seq));
    new Logger('t', 'debug', hub).info('x');
    expect(seen).toEqual([1]);
    expect(hub.allocSeq()).toBe(2);
  });

  it('onEntry 返回 dispose 函数解除订阅', () => {
    const hub = new LogHub();
    const seen: string[] = [];
    const off = hub.onEntry(e => seen.push(e.message));
    new Logger('t', 'debug', hub).info('a');
    off();
    new Logger('t', 'debug', hub).info('b');
    expect(seen).toEqual(['a']);
  });

  it('LogHub.default 是全局共享实例', () => {
    expect(LogHub.default).toBeInstanceOf(LogHub);
    const seen: string[] = [];
    const off = LogHub.default.onEntry(e => seen.push(e.scope));
    new Logger('default-test').info('x');
    off();
    expect(seen).toContain('default-test');
  });
});

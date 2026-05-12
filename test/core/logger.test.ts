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

  it('buffer 上限 500 条，循环覆盖', () => {
    const hub = new LogHub();
    const log = new Logger('t', 'debug', hub);
    for (let i = 0; i < 600; i++) log.info(`msg-${i}`);
    expect(hub.getBuffer().length).toBe(500);
    expect(hub.getBuffer()[0].message).toBe('msg-100');
    expect(hub.getBuffer()[499].message).toBe('msg-599');
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

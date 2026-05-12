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

  it('buffer 默认上限 2000 条，循环覆盖', () => {
    const hub = new LogHub();
    const log = new Logger('t', 'debug', hub);
    for (let i = 0; i < 2100; i++) log.info(`msg-${i}`);
    expect(hub.getBuffer().length).toBe(2000);
    expect(hub.getBuffer()[0].message).toBe('msg-100');
    expect(hub.getBuffer()[1999].message).toBe('msg-2099');
  });

  it('bufferMax 可构造指定 + setBufferMax 动态调整', () => {
    const hub = new LogHub(10);
    const log = new Logger('t', 'debug', hub);
    for (let i = 0; i < 15; i++) log.info(`m-${i}`);
    expect(hub.getBuffer().length).toBe(10);
    expect(hub.getBuffer()[0].message).toBe('m-5');
    // 缩小后立刻丢弃多余旧条目
    hub.setBufferMax(3);
    expect(hub.getBuffer().length).toBe(3);
    expect(hub.getBuffer()[0].message).toBe('m-12');
  });

  it('getBuffer() 返回副本，外部修改不污染内部环形 buffer', () => {
    const hub = new LogHub();
    new Logger('t', 'debug', hub).info('a');
    const snap = hub.getBuffer();
    snap.length = 0;
    snap.push({ timestamp: 'x', level: 'info', scope: 'fake', message: 'evil' });
    // 内部 buffer 不受外部 splice/push 影响
    const fresh = hub.getBuffer();
    expect(fresh).toHaveLength(1);
    expect(fresh[0].message).toBe('a');
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

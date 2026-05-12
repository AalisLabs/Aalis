import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, LogHub } from '../../packages/core/src/index.js';

/**
 * console sink 与 LogHub 行为：
 * - sink 关闭时不输出 console，但缓冲与监听器仍生效
 * - 多 hub 隔离（应用自己的 hub 不影响 LogHub.default）
 */

describe('LogHub / console sink', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    LogHub.default.setConsoleSinkEnabled(true);
    logSpy.mockClear();
  });
  afterEach(() => {
    LogHub.default.setConsoleSinkEnabled(true);
  });

  it('启用时 Logger.info → console.log 被调用', () => {
    const logger = new Logger('t', 'debug');
    logger.info('hello');
    expect(logSpy).toHaveBeenCalled();
    const call = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(call).toContain('hello');
    expect(call).toContain('INFO');
  });

  it('disable 后 console 静默，但缓冲与监听器仍工作', () => {
    LogHub.default.setConsoleSinkEnabled(false);
    logSpy.mockClear();
    const captured: string[] = [];
    const off = LogHub.default.onEntry(e => captured.push(e.message));

    const logger = new Logger('quiet', 'debug');
    logger.info('m1');
    logger.warn('m2');

    expect(logSpy).not.toHaveBeenCalled();
    expect(captured).toEqual(['m1', 'm2']);
    const buf = LogHub.default.getBuffer();
    expect(buf.some(e => e.message === 'm1')).toBe(true);
    off();
  });

  it('isConsoleSinkEnabled 反映 toggle', () => {
    expect(LogHub.default.isConsoleSinkEnabled()).toBe(true);
    LogHub.default.setConsoleSinkEnabled(false);
    expect(LogHub.default.isConsoleSinkEnabled()).toBe(false);
  });

  it('Logger 携带额外 args 时透传给 console.log', () => {
    const logger = new Logger('args', 'debug');
    logger.info('with-args', { a: 1 }, 42);
    const lastCall = logSpy.mock.calls.at(-1);
    expect(lastCall?.slice(1)).toEqual([{ a: 1 }, 42]);
  });

  it('多 hub 隔离：自定义 hub 关闭 sink 不影响 default', () => {
    const sandboxHub = new LogHub();
    sandboxHub.setConsoleSinkEnabled(false);
    expect(sandboxHub.isConsoleSinkEnabled()).toBe(false);
    expect(LogHub.default.isConsoleSinkEnabled()).toBe(true);

    logSpy.mockClear();
    new Logger('sandbox', 'debug', sandboxHub).info('only-sandbox');
    expect(logSpy).not.toHaveBeenCalled();
    expect(sandboxHub.getBuffer().some(e => e.message === 'only-sandbox')).toBe(true);
  });

  it('低于 minLevel 不入缓冲', () => {
    const hub = new LogHub();
    hub.setConsoleSinkEnabled(false);
    const logger = new Logger('lvl', 'warn', hub);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    const buf = hub.getBuffer();
    expect(buf.map(e => e.level)).toEqual(['warn', 'error']);
  });

  it('缓冲容量上限（默认 500 条 FIFO）', () => {
    const hub = new LogHub();
    hub.setConsoleSinkEnabled(false);
    const logger = new Logger('cap', 'debug', hub);
    for (let i = 0; i < 600; i++) logger.info(`m${i}`);
    const buf = hub.getBuffer();
    expect(buf.length).toBe(500);
    expect(buf[0].message).toBe('m100');
    expect(buf.at(-1)?.message).toBe('m599');
  });
});

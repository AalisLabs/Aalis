import { describe, expect, it } from 'vitest';
import { DefaultLogger, LogHub } from '../../packages/core/src/index.js';

describe('LogHub', () => {
  it('Logger 写入 → LogHub.push → 触发 onEntry 监听器', () => {
    const hub = new LogHub();
    const captured: string[] = [];
    hub.onEntry(e => captured.push(`${e.level}:${e.scope}:${e.message}`));
    const log = new DefaultLogger('t', 'debug', hub);
    log.info('hello');
    log.warn('oops');
    expect(captured).toEqual(['info:t:hello', 'warn:t:oops']);
  });

  it('Logger.child 继承同一 hub 与 minLevel', () => {
    const hub = new LogHub();
    const seen: string[] = [];
    hub.onEntry(e => seen.push(e.scope));
    const root = new DefaultLogger('root', 'info', hub);
    const child = root.child('sub');
    child.info('x');
    expect(seen).toEqual(['root:sub']);
  });

  it('minLevel 低于阈值的日志被丢弃', () => {
    const hub = new LogHub();
    const seen: string[] = [];
    hub.onEntry(e => seen.push(e.level));
    const log = new DefaultLogger('t', 'warn', hub);
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
    const log = new DefaultLogger('t', 'debug', hub);
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
    new DefaultLogger('t', 'debug', hub).info('x');
    expect(seen).toEqual([1]);
    expect(hub.allocSeq()).toBe(2);
  });

  it('onEntry 返回 dispose 函数解除订阅', () => {
    const hub = new LogHub();
    const seen: string[] = [];
    const off = hub.onEntry(e => seen.push(e.message));
    new DefaultLogger('t', 'debug', hub).info('a');
    off();
    new DefaultLogger('t', 'debug', hub).info('b');
    expect(seen).toEqual(['a']);
  });

  it('LogHub.default 是全局共享实例', () => {
    expect(LogHub.default).toBeInstanceOf(LogHub);
    const seen: string[] = [];
    const off = LogHub.default.onEntry(e => seen.push(e.scope));
    new DefaultLogger('default-test').info('x');
    off();
    expect(seen).toContain('default-test');
  });

  it('timestamp 是带本地时区偏移的 ISO-8601（非裸 Z），且可被 Date 解析回相同瞬间', () => {
    const hub = new LogHub();
    const captured: string[] = [];
    hub.onEntry(e => captured.push(e.timestamp));
    new DefaultLogger('tz', 'debug', hub).info('x');
    expect(captured).toHaveLength(1);
    const ts = captured[0];
    // 形如 2026-05-27T09:09:16.028+01:00 或 ...Z（偏移为 0 时）
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/);
    // 解析回 Date 后毫秒级别接近 now（差距 < 1s）
    const parsed = Date.parse(ts);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(Math.abs(parsed - Date.now())).toBeLessThan(1000);
  });
});

describe('AppOptions.logger 注入（Logger 接口化）', () => {
  it('注入自定义 Logger 后 core 日志走注入实现，LogHub 管线不再被写入', async () => {
    const { App } = await import('../../packages/core/src/index.js');
    const lines: string[] = [];
    const make = (scope: string): import('../../packages/core/src/index.js').Logger => ({
      debug: m => lines.push(`${scope}|debug|${m}`),
      info: m => lines.push(`${scope}|info|${m}`),
      warn: m => lines.push(`${scope}|warn|${m}`),
      error: m => lines.push(`${scope}|error|${m}`),
      child: s => make(`${scope}:${s}`),
    });
    const hub = new LogHub();
    const hubEntries: unknown[] = [];
    hub.onEntry(e => hubEntries.push(e));

    const app = new App({
      config: { name: 'InjectTest', logLevel: 'debug', plugins: {} },
      logger: make('custom'),
      logHub: hub,
    });
    await app.plugin({ name: 'p1', apply() {} });

    // core 的启动/插件日志全部进了注入 logger（含 child 派生的 plugins 作用域）
    expect(lines.some(l => l.startsWith('custom|info|Aalis'))).toBe(true);
    expect(lines.some(l => l.startsWith('custom:plugins|info|插件已注册'))).toBe(true);
    // LogHub 管线未被写入（注入方自理后端）
    expect(hubEntries).toEqual([]);
    await app.stop();
  });
});

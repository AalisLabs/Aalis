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

describe('DefaultLogger 时钟注入（确定性时间戳）', () => {
  it('注入固定时钟 → 时间戳确定、不取墙上时间', () => {
    const hub = new LogHub();
    const seen: string[] = [];
    hub.onEntry(e => seen.push(e.timestamp));
    const fixed = new Date('2020-06-15T08:30:00.000Z');
    const log = new DefaultLogger('t', 'debug', hub, () => fixed);
    log.info('a');
    log.info('b');
    // 两条都用注入时钟 → 时间戳相同（墙上时钟会各不相同），且解析回等于注入瞬间
    expect(seen[0]).toBe(seen[1]);
    expect(new Date(seen[0]).getTime()).toBe(fixed.getTime());
  });

  it('child 继承注入的时钟', () => {
    const hub = new LogHub();
    let ts = '';
    hub.onEntry(e => {
      ts = e.timestamp;
    });
    const fixed = new Date('2021-01-01T00:00:00.000Z');
    new DefaultLogger('root', 'info', hub, () => fixed).child('sub').info('x');
    expect(new Date(ts).getTime()).toBe(fixed.getTime());
  });

  it('不注入时默认取当前时间（保持现行为、不破坏）', () => {
    const hub = new LogHub();
    let ts = '';
    hub.onEntry(e => {
      ts = e.timestamp;
    });
    new DefaultLogger('t', 'debug', hub).info('x'); // 3 参，走默认时钟
    expect(Math.abs(Date.parse(ts) - Date.now())).toBeLessThan(1000);
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
      name: 'InjectTest',
      logLevel: 'debug',
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

describe('附加参数渲染（core 记错误一律把错误对象作附加参数，靠这里带出 stack）', () => {
  it('Error 渲染成 stack（含 message 与调用帧），跨 realm 的带 stack 对象同样打 stack', () => {
    const hub = new LogHub();
    const messages: string[] = [];
    hub.onEntry(e => messages.push(e.message));
    const log = new DefaultLogger('t', 'debug', hub);
    log.error('加载失败:', new Error('boom'));
    log.warn('跨 realm:', { stack: 'FakeError: far\n    at somewhere' });
    expect(messages[0]).toContain('加载失败:');
    expect(messages[0]).toContain('Error: boom');
    expect(messages[0], '内插 message 会丢掉调用帧，附加参数不会').toMatch(/\n\s+at /);
    // 鸭子分支把 stack 原样打出；退化到 JSON.stringify 会变成 {"stack":"…\\n…"}，换行成字面量
    expect(messages[1]).toMatch(/跨 realm: FakeError: far\n\s+at somewhere$/);
  });

  it('JSON.stringify 失败后 String(v) 也抛的对象（null 原型带循环引用 / BigInt）不让日志调用抛出', () => {
    const hub = new LogHub();
    const messages: string[] = [];
    hub.onEntry(e => messages.push(e.message));
    const log = new DefaultLogger('t', 'debug', hub);
    const cyclic: Record<string, unknown> = Object.create(null);
    cyclic.self = cyclic;
    const withBigInt: Record<string, unknown> = Object.create(null);
    withBigInt.n = 1n;
    const plainCyclic: Record<string, unknown> = {};
    plainCyclic.self = plainCyclic;
    expect(() => log.warn('循环:', cyclic)).not.toThrow();
    expect(() => log.warn('大整数:', withBigInt)).not.toThrow();
    log.warn('普通循环:', plainCyclic);
    expect(messages).toEqual(['循环: [object Object]', '大整数: [object Object]', '普通循环: [object Object]']);
  });

  it('渲染本身会抛的参数（已撤销的 Proxy、stack getter 抛错、getPrototypeOf 陷阱抛错）输出固定占位串，日志调用不抛', () => {
    const hub = new LogHub();
    const messages: string[] = [];
    hub.onEntry(e => messages.push(e.message));
    const log = new DefaultLogger('t', 'debug', hub);
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const badStack = {
      get stack(): string {
        throw new Error('stack getter');
      },
    };
    const badProto = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('getPrototypeOf trap');
        },
      },
    );
    expect(() => log.error('撤销:', revocable.proxy)).not.toThrow();
    expect(() => log.error('stack:', badStack)).not.toThrow();
    expect(() => log.error('原型:', badProto, '其余参数照常')).not.toThrow();
    expect(messages).toEqual([
      '撤销: [无法渲染的参数]',
      'stack: [无法渲染的参数]',
      '原型: [无法渲染的参数] 其余参数照常',
    ]);
  });

  it('渲染结果不是字符串（stack 被赋成非字符串、toJSON 返回 undefined）时在兜底内规整，日志调用不抛', () => {
    const hub = new LogHub();
    const messages: string[] = [];
    hub.onEntry(e => messages.push(e.message));
    const log = new DefaultLogger('t', 'debug', hub);
    const symbolStack = new Error('x');
    (symbolStack as { stack?: unknown }).stack = Symbol('s');
    const nullProtoStack = new Error('x');
    (nullProtoStack as { stack?: unknown }).stack = Object.create(null);
    // 鸭子分支：类型检查时读到字符串，取值时第二次读到 null 原型对象
    let reads = 0;
    const flipStack = {
      get stack(): unknown {
        reads += 1;
        return reads === 1 ? 'at x' : Object.create(null);
      },
    };
    expect(() => log.error('Symbol:', symbolStack)).not.toThrow();
    expect(() => log.error('null 原型:', nullProtoStack)).not.toThrow();
    expect(() => log.error('二次读取:', flipStack)).not.toThrow();
    log.error('toJSON:', { toJSON: () => undefined });
    expect(messages).toEqual([
      'Symbol: Symbol(s)',
      'null 原型: [无法渲染的参数]',
      '二次读取: [无法渲染的参数]',
      'toJSON: undefined',
    ]);
  });
});

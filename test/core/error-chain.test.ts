import { afterEach, describe, expect, it } from 'vitest';
import { assertOwnCopy } from '../../packages/core/src/composition/descriptors.js';
import {
  App,
  DefaultLogger,
  definePlugin,
  defineService,
  LogHub,
  type PluginDefinition,
} from '../../packages/core/src/index.js';
import { summarizeError } from '../../packages/core/src/infrastructure/logger.js';

// ════════════════════════════════════════════════════════════
// 错误因果链：DefaultLogger 在最外层 stack 之后逐层列出 cause 与 AggregateError 的子错误，
// PluginEntry.error 与注册校验失败的原因在消息后接 cause 链摘要；两者共用层数上限与循环保护，渲染绝不抛。
// ════════════════════════════════════════════════════════════

function capture() {
  const hub = new LogHub();
  const messages: string[] = [];
  hub.onEntry(e => void messages.push(e.message));
  return { log: new DefaultLogger('t', 'debug', hub), messages };
}

/** 去掉最外层 stack 的调用帧，只留首行与因果链 */
function withoutFrames(message: string): string {
  return message
    .split('\n')
    .filter(line => !/^\s+at /.test(line))
    .join('\n');
}

describe('DefaultLogger 渲染错误因果链', () => {
  it('单层 cause：最外层照旧输出 stack，其后一行 [cause] 名称: 消息', () => {
    const { log, messages } = capture();
    log.error('请求失败:', new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') }));
    expect(messages[0], '最外层保留调用帧').toMatch(/^请求失败: TypeError: fetch failed\n\s+at /);
    expect(withoutFrames(messages[0])).toBe(
      '请求失败: TypeError: fetch failed\n[cause] Error: connect ECONNREFUSED 127.0.0.1:11434',
    );
  });

  it('多层 cause 逐层一行、只有最外层带 stack；消息为空的层只写名称', () => {
    const { log, messages } = capture();
    const root = new RangeError('');
    log.error('x', new Error('outer', { cause: new SyntaxError('middle', { cause: root }) }));
    expect(withoutFrames(messages[0])).toBe('x Error: outer\n[cause] SyntaxError: middle\n[cause] RangeError');
    expect(messages[0].slice(messages[0].indexOf('\n[cause]')), '内层的调用帧不输出').not.toMatch(/\n\s+at /);
  });

  it('AggregateError：最外层与 cause 层都列出 [errors] N 项与每项一行，超过 10 条写「…另 N 项」', () => {
    const { log, messages } = capture();
    const items = Array.from({ length: 12 }, (_, i) => new Error(`e${i}`));
    log.error('all:', new AggregateError(items, 'all failed'));
    expect(withoutFrames(messages[0])).toBe(
      [
        'all: AggregateError: all failed',
        '[errors] 12 项',
        ...items.slice(0, 10).map(e => `  Error: ${e.message}`),
        '  …另 2 项',
      ].join('\n'),
    );

    const refused = new AggregateError([new Error('connect ECONNREFUSED ::1:11434'), 'plain', { code: 'X' }], '', {
      cause: new Error('after aggregate'),
    });
    log.error('fetch:', new TypeError('fetch failed', { cause: refused }));
    expect(withoutFrames(messages[1])).toBe(
      [
        'fetch: TypeError: fetch failed',
        '[cause] AggregateError',
        '[errors] 3 项',
        '  Error: connect ECONNREFUSED ::1:11434',
        '  plain',
        '  {"code":"X"}',
        '[cause] Error: after aggregate',
      ].join('\n'),
    );

    const ten = Array.from({ length: 10 }, (_, i) => new Error(`t${i}`));
    log.error('ten:', new AggregateError(ten, 'ten'));
    expect(withoutFrames(messages[2]), '恰好 10 条不写「…另 0 项」').toBe(
      ['ten: AggregateError: ten', '[errors] 10 项', ...ten.map(e => `  Error: ${e.message}`)].join('\n'),
    );
  });

  it('循环引用：自指、互指与不经过起点的尾部循环都在回到已列出的错误时停下并写明', () => {
    const { log, messages } = capture();
    const self = new Error('self');
    self.cause = self;
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    const tail = new Error('a');
    tail.cause = new Error('b', { cause: tail });
    log.error('自指', self);
    log.error('互指', b);
    log.error('尾部循环', new Error('x', { cause: tail }));
    expect(messages.map(withoutFrames)).toEqual([
      '自指 Error: self\n[cause] [循环引用]',
      '互指 Error: b\n[cause] Error: a\n[cause] [循环引用]',
      '尾部循环 Error: x\n[cause] Error: a\n[cause] Error: b\n[cause] [循环引用]',
    ]);
  });

  it('非 Error 的 cause 按附加参数规则渲染成一行，且不再往下走', () => {
    const { log, messages } = capture();
    log.error('字符串', new Error('x', { cause: 'line1\nline2' }));
    log.error('对象', new Error('x', { cause: { code: 'E', cause: new Error('不展开') } }));
    log.error('跨 realm', new Error('x', { cause: { stack: 'FarError: far\n    at somewhere' } }));
    log.error('null', new Error('x', { cause: null }));
    expect(messages.map(withoutFrames)).toEqual([
      '字符串 Error: x\n[cause] line1',
      '对象 Error: x\n[cause] {"code":"E","cause":{}}',
      '跨 realm Error: x\n[cause] FarError: far',
      'null Error: x\n[cause] null',
    ]);
  });

  it('深度上限 5：更深的层不列，末行写明', () => {
    const { log, messages } = capture();
    let error = new Error('L7');
    for (let i = 6; i >= 1; i--) error = new Error(`L${i}`, { cause: error });
    log.error('深', error);
    expect(withoutFrames(messages[0])).toBe(
      ['深 Error: L1', ...[2, 3, 4, 5, 6].map(i => `[cause] Error: L${i}`), '[cause] [超过 5 层，其余省略]'].join('\n'),
    );
  });

  it('渲染绝不抛：cause 读取、层内名称与消息、errors 读取抛错只影响那一处，最外层照常输出', () => {
    const { log, messages } = capture();
    const badGetter = new Error('outer');
    Object.defineProperty(badGetter, 'cause', {
      get() {
        throw new Error('cause getter');
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const badMessage = new Error('inner');
    Object.defineProperty(badMessage, 'message', {
      get() {
        throw new Error('message getter');
      },
    });
    const badErrors = new AggregateError([], 'agg');
    Object.defineProperty(badErrors, 'errors', {
      get() {
        throw new Error('errors getter');
      },
    });
    const nonArrayErrors = new AggregateError([], 'agg2');
    Object.defineProperty(nonArrayErrors, 'errors', { value: 42 });
    expect(() => {
      log.error('a', badGetter);
      log.error('b', new Error('outer', { cause: revoked.proxy }));
      log.error('c', new Error('outer', { cause: badMessage }));
      log.error('d', badErrors);
      log.error('e', nonArrayErrors);
    }).not.toThrow();
    expect(messages.map(withoutFrames)).toEqual([
      'a Error: outer\n[cause] [无法渲染的参数]',
      'b Error: outer\n[cause] [无法渲染的参数]',
      'c Error: outer\n[cause] [无法渲染的参数]',
      'd AggregateError: agg',
      'e AggregateError: agg2',
    ]);
  });
});

describe('PluginEntry.error 的因果链摘要', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop();
  });

  async function failWith(thrown: unknown) {
    const hub = new LogHub();
    const errors: string[] = [];
    hub.onEntry(e => {
      if (e.level === 'error') errors.push(e.message);
    });
    const app = new App({ name: 'T', logHub: hub });
    apps.push(app);
    await app.plugin(
      definePlugin({
        name: 'failing',
        apply() {
          throw thrown;
        },
      }),
    );
    await app.plugins.idle();
    const entry = app.plugins.getPlugin('failing');
    expect(entry?.state).toBe('error');
    return { error: entry?.error, errors };
  }

  it('消息后接各层消息首行，以 ← 相连；激活失败的日志带出完整因果链', async () => {
    const thrown = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:11434\n第二行不进摘要'),
    });
    const { error, errors } = await failWith(thrown);
    expect(error).toBe('fetch failed ← connect ECONNREFUSED 127.0.0.1:11434');
    expect(errors.map(withoutFrames)).toEqual([
      '插件 "failing" 激活失败: TypeError: fetch failed\n[cause] Error: connect ECONNREFUSED 127.0.0.1:11434\n第二行不进摘要',
    ]);
  });

  it('上一层首行以本层首行结尾、且两者相同或以冒号分隔时省略本层（包装错误常把 cause 的消息拼在末尾）', async () => {
    const original = new Error('unable to open database file', { cause: new Error('EACCES') });
    const { error } = await failWith(new Error(`SQLite 打开失败: ${original.message}`, { cause: original }));
    expect(error).toBe('SQLite 打开失败: unable to open database file ← EACCES');
    const multiline = new Error('第一行\n第二行');
    expect(
      summarizeError(new Error(`读取失败：${multiline.message}`, { cause: multiline })),
      '全角冒号；与上一层的首行比较',
    ).toBe('读取失败：第一行\n第二行');
    expect(summarizeError(new Error('same', { cause: new Error('same') })), '两层相同').toBe('same');
  });

  it('本层首行只是出现在上一层中间，或未以冒号与前文分隔时不省略', () => {
    expect(summarizeError(new Error('无法连接数据库：请检查 host 配置', { cause: new Error('host') }))).toBe(
      '无法连接数据库：请检查 host 配置 ← host',
    );
    expect(summarizeError(new Error('Request failed with status 500', { cause: new Error('500') }))).toBe(
      'Request failed with status 500 ← 500',
    );
  });

  it('首行为空的层不列，去重仍以上一个非空首行为准；被省略的层仍接其子错误', () => {
    expect(summarizeError(new Error('x', { cause: '' }))).toBe('x');
    expect(summarizeError(new Error('x', { cause: new Error('\n隐藏', { cause: new Error('c') }) }))).toBe('x ← c');
    expect(summarizeError(new Error('x: c', { cause: new Error('\n隐藏', { cause: new Error('c') }) }))).toBe('x: c');
    const aggregate = new AggregateError([new Error('a'), new Error('b')], '');
    expect(summarizeError(new Error('failed: AggregateError', { cause: aggregate }))).toBe(
      'failed: AggregateError: a; b',
    );
  });

  it('去重与上一层比较，不与最外层比较', () => {
    const chain = (a: string, b: string, c: string) => new Error(a, { cause: new Error(b, { cause: new Error(c) }) });
    expect(summarizeError(chain('outer', 'mid: root', 'root'))).toBe('outer ← mid: root');
    expect(summarizeError(chain('top: root', 'mid', 'root'))).toBe('top: root ← mid ← root');
  });

  it('AggregateError 层（最外层或 cause 层）之后接子错误的首行，以 ; 相连，至多 3 条，超出写「…另 N 项」', async () => {
    const refused = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:11434'), new Error('connect ECONNREFUSED 127.0.0.1:11434')],
      '',
    );
    expect((await failWith(new TypeError('fetch failed', { cause: refused }))).error).toBe(
      'fetch failed ← AggregateError: connect ECONNREFUSED ::1:11434; connect ECONNREFUSED 127.0.0.1:11434',
    );
    const items = (n: number) => Array.from({ length: n }, (_, i) => new Error(`e${i}\n第二行不进摘要`));
    expect(summarizeError(new AggregateError(items(5), 'all failed'))).toBe('all failed: e0; e1; e2; …另 2 项');
    expect(summarizeError(new AggregateError(items(3), 'all failed')), '恰好 3 条不写「…另 0 项」').toBe(
      'all failed: e0; e1; e2',
    );
    const mixed = new AggregateError(['plain\nmore', { code: 'X' }], '', { cause: new Error('after aggregate') });
    expect(summarizeError(new Error('outer', { cause: mixed })), '非 Error 子错误同样取首行；其后照常接 cause').toBe(
      'outer ← AggregateError: plain; {"code":"X"} ← after aggregate',
    );
    const badErrors = new AggregateError([], 'agg');
    Object.defineProperty(badErrors, 'errors', {
      get() {
        throw new Error('errors getter');
      },
    });
    expect(summarizeError(badErrors), '读取 errors 抛错时不列').toBe('agg');
  });

  it('非 Error 抛出值按附加参数规则渲染：转不成原始值的对象不再让激活收尾抛错', async () => {
    expect((await failWith(Object.create(null))).error).toBe('{}');
    expect((await failWith({ code: 'E1' })).error).toBe('{"code":"E1"}');
  });

  it('非 Error 的值在摘要里只取首行并限 200 字符，超出以「…」结尾；日志照旧完整输出', async () => {
    const farError = { stack: 'FarError: far\n    at somewhere (x.js:1:1)' };
    const { error, errors } = await failWith(farError);
    expect(error, '带字符串 stack 的对象不带出调用帧').toBe('FarError: far');
    expect(errors).toEqual([`插件 "failing" 激活失败: ${farError.stack}`]);
    expect(summarizeError('line1\nline2')).toBe('line1');
    expect(summarizeError('x'.repeat(200)), '恰好 200 字符不截').toBe('x'.repeat(200));
    expect(summarizeError('x'.repeat(201))).toBe(`${'x'.repeat(199)}…`);
    expect(summarizeError(`${'x'.repeat(198)}😀tail`), '不截在代理对中间').toBe(`${'x'.repeat(198)}…`);
    const long = { data: 'y'.repeat(300) };
    expect(summarizeError(new Error('outer', { cause: long })), 'cause 层同样限长').toBe(
      `outer ← ${JSON.stringify(long).slice(0, 199)}…`,
    );
    const { log, messages } = capture();
    log.error('x', new Error('outer', { cause: long }));
    expect(withoutFrames(messages[0])).toBe(`x Error: outer\n[cause] ${JSON.stringify(long)}`);
  });

  it('深度上限与循环保护同日志；消息为空的层取名称；无法渲染时给占位串', () => {
    let deep = new Error('L7');
    for (let i = 6; i >= 1; i--) deep = new Error(`L${i}`, { cause: deep });
    expect(summarizeError(deep)).toBe('L1 ← L2 ← L3 ← L4 ← L5 ← L6 ← [超过 5 层，其余省略]');
    const a = new Error('a');
    a.cause = new Error('b', { cause: a });
    expect(summarizeError(a)).toBe('a ← b ← [循环引用]');
    const tail = new Error('a');
    tail.cause = new Error('b', { cause: tail });
    expect(summarizeError(new Error('x', { cause: tail })), '不经过起点的尾部循环').toBe('x ← a ← b ← [循环引用]');
    expect(summarizeError(new Error('', { cause: new AggregateError([]) }))).toBe('Error ← AggregateError');
    const hostile = new Proxy(new Error('x'), {
      getPrototypeOf() {
        throw new Error('trap');
      },
    });
    expect(summarizeError(hostile)).toBe('[无法渲染的参数]');
  });

  it('注册校验失败的原因用同一说明：抛出转不成原始值的对象时 register 仍兑现 false', async () => {
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry(e => {
      if (e.level === 'warn') warns.push(e.message);
    });
    const app = new App({ name: 'T', logHub: hub });
    apps.push(app);
    const definition = {
      name: 'odd-uses',
      get uses(): never {
        throw Object.create(null);
      },
      apply() {},
    } as unknown as PluginDefinition;
    await expect(app.plugins.register(definition)).resolves.toBe(false);
    expect(warns).toEqual(['插件定义校验失败，拒绝注册: {}']);
  });
});

describe('core 错误类带名称', () => {
  it('ServiceUnavailableError 与 ForeignCoreError 的 name 与 stack 首行都是类名', async () => {
    const app = new App({ name: 'T', logHub: new LogHub() });
    const missing = defineService('error-chain-missing');
    let unavailable: unknown;
    try {
      app.bind({ missing }).missing.require();
    } catch (error) {
      unavailable = error;
    }
    let foreign: unknown;
    try {
      assertOwnCopy({ [Symbol.for('aalis.core.minted')]: Symbol('another copy') }, '描述符');
    } catch (error) {
      foreign = error;
    }
    expect(unavailable).toBeInstanceOf(Error);
    expect(foreign).toBeInstanceOf(Error);
    expect((unavailable as Error).name).toBe('ServiceUnavailableError');
    expect((unavailable as Error).stack).toMatch(/^ServiceUnavailableError: 服务 "error-chain-missing" 不可用/);
    expect((foreign as Error).name).toBe('ForeignCoreError');
    expect((foreign as Error).stack).toMatch(/^ForeignCoreError: 描述符来自另一份 @aalis\/core/);
    await app.stop();
  });
});

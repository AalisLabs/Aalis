import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionGuardContext } from '../../packages/api-authority/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type {
  BackgroundTaskChange,
  RegisteredTool,
  ToolCallContext,
  ToolExecutionResult,
  ToolOutputMessage,
} from '../../packages/api-tools/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { BackgroundTasks } from '../../packages/plugin-tools/src/background.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import { type IncomingMessage, selfInitiatedActor } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 工具执行器一层的转后台（plugin-tools）：声明了 background 的工具多两项参数（runInBackground、waitSeconds），
// 过了守卫之后先等让出时限，到时没结束就登记成后台任务、先回给模型；登记表（backgroundTasks）可查、可取输出、可停，
// 停用与撤回时落成 aborted，会话删除时停掉并删掉，状态变了写进插件数据。正常结束（含失败）时向起它的会话注入结束通知，
// 身份取起它的那次调用。四个后台任务工具只在有可转后台的工具时下发。全程假计时器与替身工具，不起真实进程。
// ════════════════════════════════════════════════════════════

const SESSION = 'zz-6b-session';
const OTHER = 'zz-6b-other';
const GROUP = 'onebot:10000:group:20001';

interface Run {
  args: Record<string, unknown>;
  ctx: ToolCallContext;
  finish(result?: string): void;
}

type Spec = Partial<Omit<RegisteredTool, 'pluginName' | 'handler'>> & { hang?: boolean };

/** 替身工具：每次调用记一条，由用例手动落定；中止时按 { aborted: true } 落定（hang 的不理会中止） */
function slowTool(runs: Run[], name: string, spec: Spec = {}): Omit<RegisteredTool, 'pluginName'> {
  const { hang, ...rest } = spec;
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: name,
        parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
      },
    },
    background: {},
    ...rest,
    handler: (args, ctx) =>
      new Promise(resolve => {
        runs.push({ args, ctx, finish: (result = 'zz-done') => resolve(result) });
        if (!hang)
          ctx.signal?.addEventListener('abort', () => resolve(JSON.stringify({ aborted: true })), { once: true });
      }),
  };
}

interface WorldOptions {
  maxWaitSeconds?: number;
  maxPerSession?: number;
  isOwner?: (identity: { platform: string; userId: string }) => boolean;
  guard?: (ctx: ExecutionGuardContext) => Promise<string | null>;
}

function world(opts: WorldOptions = {}) {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const warnings: string[] = [];
  const logger = {
    child: () => logger,
    debug() {},
    info() {},
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    error() {},
  } as unknown as Logger;
  const events = {
    emit: async (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    },
  };
  const tasks = new BackgroundTasks({
    logger,
    events: events as never,
    limits: { maxWaitSeconds: opts.maxWaitSeconds ?? 600, maxPerSession: opts.maxPerSession ?? 4 },
    isOwner: opts.isOwner ?? (() => false),
  });
  const registry = new ToolRegistry(logger, tasks);
  const guarded: ExecutionGuardContext[] = [];
  registry.setExecutionGuard(async ctx => {
    guarded.push(ctx);
    return (await opts.guard?.(ctx)) ?? null;
  });
  const runs: Run[] = [];
  const of = <T>(event: string) => emitted.filter(e => e.event === event).map(e => e.payload as T);
  return {
    tasks,
    registry,
    runs,
    guarded,
    warnings,
    slow: (name = 'zz_slow', spec: Spec = {}) => registry.register(slowTool(runs, name, spec), 'zz-test'),
    plain: (name: string, handler: RegisteredTool['handler']) =>
      registry.register(
        {
          definition: {
            type: 'function',
            function: { name, description: name, parameters: { type: 'object', properties: {} } },
          },
          handler,
        },
        'zz-test',
      ),
    outputs: () => of<ToolOutputMessage>('tool:output'),
    changes: () => of<BackgroundTaskChange>('background:changed'),
    notices: () => of<IncomingMessage>('inbound:message'),
  };
}

let seq = 0;
/** agent 回合里的调用：owner 的 WebUI 会话，带回合的中止信号 */
function turn(over: Partial<ToolCallContext> = {}) {
  const controller = new AbortController();
  seq++;
  const ctx: ToolCallContext = {
    sessionId: SESSION,
    platform: 'webui',
    userId: 'console',
    enabledGroups: [],
    acceptsImages: true,
    signal: controller.signal,
    inbound: {},
    turnId: `zz-turn-${seq}`,
    callId: `zz-call-${seq}`,
    ...over,
  };
  return { ctx, abort: () => controller.abort() };
}

const parse = (result: ToolExecutionResult) => JSON.parse(result.content) as Record<string, unknown>;
const flush = () => vi.advanceTimersByTimeAsync(0);

/** 记下一个 promise 是否已落定 */
function track<T>(promise: Promise<T>) {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return { value: promise, done: () => done };
}

/** 插件数据的替身：只有 readFile 与 writeFile，文件不存在时抛 ENOENT */
function memoryStore(seed?: unknown, opts: { broken?: boolean } = {}) {
  const files = new Map<string, string>();
  if (seed !== undefined) files.set('pluginData:/tools/background-tasks.json', JSON.stringify(seed));
  let writes = 0;
  const service = {
    async readFile(uri: string) {
      if (opts.broken) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const text = files.get(uri);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      return text;
    },
    async writeFile(uri: string, data: string) {
      writes++;
      files.set(uri, data);
    },
  } as unknown as StorageService;
  return {
    service,
    writes: () => writes,
    saved: () => {
      const text = files.get('pluginData:/tools/background-tasks.json');
      return text === undefined ? undefined : (JSON.parse(text) as { tasks: Array<Record<string, unknown>> });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('声明与参数', () => {
  it('声明了的工具多两项参数，没声明的不变', () => {
    const w = world();
    w.slow('zz_slow', { background: { yieldSeconds: 12 } });
    w.slow('zz_plain', { background: undefined });
    const defs = Object.fromEntries(w.registry.getDefinitions().map(d => [d.function.name, d.function.parameters]));
    expect(Object.keys(defs.zz_slow.properties)).toEqual(['text', 'runInBackground', 'waitSeconds']);
    expect(defs.zz_slow.properties.runInBackground).toMatchObject({ type: 'boolean' });
    expect(defs.zz_slow.properties.waitSeconds).toMatchObject({ type: 'number' });
    expect(String((defs.zz_slow.properties.waitSeconds as { description: string }).description)).toContain('12');
    expect(defs.zz_slow.additionalProperties).toBe(false);
    expect(defs.zz_plain).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('参数表里已有同名项的工具当作没声明：参数原样、记一条告警、照常登记，执行时不取出也不转后台', async () => {
    const w = world();
    w.slow('zz_bridged', {
      definition: {
        type: 'function',
        function: {
          name: 'zz_bridged',
          description: 'zz_bridged',
          parameters: { type: 'object', properties: { waitSeconds: { type: 'number' } } },
        },
      },
    });
    const [def] = w.registry.getDefinitions();
    expect(Object.keys(def.function.parameters.properties)).toEqual(['waitSeconds']);
    expect(w.warnings.some(m => m.includes('zz_bridged') && m.includes('waitSeconds'))).toBe(true);
    const call = track(w.registry.execute('zz_bridged', { waitSeconds: 1 }, turn().ctx));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(call.done()).toBe(false);
    expect(w.runs[0].args).toEqual({ waitSeconds: 1 });
    w.runs[0].finish('zz-bridged-result');
    expect((await call.value).content).toBe('zz-bridged-result');
    expect(w.tasks.list()).toEqual([]);
  });

  it('两项在校验、守卫与工具之前取出：审批事实与工具拿到的参数里都没有它们', async () => {
    const w = world();
    w.slow();
    const result = parse(await w.registry.execute('zz_slow', { text: 'a', runInBackground: true }, turn().ctx));
    expect(result.error).toBeUndefined();
    expect(w.guarded[0].args).toEqual({ text: 'a' });
    expect(w.runs[0].args).toEqual({ text: 'a' });
  });

  it('两项的类型不对时回错，不执行', async () => {
    const w = world();
    w.slow();
    for (const args of [{ runInBackground: 'yes' }, { waitSeconds: '5' }, { waitSeconds: -1 }]) {
      const result = parse(await w.registry.execute('zz_slow', args, turn().ctx));
      expect(String(result.error)).toMatch(/runInBackground|waitSeconds/);
    }
    expect(w.runs).toEqual([]);
    expect(w.guarded).toEqual([]);
  });
});

describe('让出', () => {
  it('让出时限从过了守卫之后算起；到时没结束就转后台，回给模型任务 id、已有输出的末尾与可以先回复', async () => {
    const w = world({ guard: () => new Promise(resolve => setTimeout(() => resolve(null), 100_000)) });
    w.slow();
    const t0 = Date.now();
    const call = track(w.registry.execute('zz_slow', {}, turn().ctx));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(w.runs).toHaveLength(1);
    w.runs[0].ctx.output?.('zz-early-line\n');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(call.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.done()).toBe(true);
    const result = parse(await call.value);
    expect(result.taskId).toMatch(/^bg_/);
    expect(result.status).toBe('running');
    expect(result.output).toContain('zz-early-line');
    expect(result.message).toContain('结束时会通知你');
    expect(result.message).toContain('可以先回复');
    const [task] = w.tasks.list();
    expect(task).toMatchObject({
      id: result.taskId,
      sessionId: SESSION,
      kind: 'tool-call',
      label: 'zz_slow',
      status: 'running',
      startedAt: t0 + 100_000,
      lastLine: 'zz-early-line',
    });
    expect(task.call).toMatchObject({ tool: 'zz_slow', args: {} });
  });

  it('工具声明的让出时限；waitSeconds 改它，超过配置上限按上限', async () => {
    const w = world({ maxWaitSeconds: 60 });
    w.slow('zz_slow', { background: { yieldSeconds: 5 } });
    const byTool = track(w.registry.execute('zz_slow', {}, turn().ctx));
    const byArg = track(w.registry.execute('zz_slow', { waitSeconds: 8 }, turn().ctx));
    const capped = track(w.registry.execute('zz_slow', { waitSeconds: 1000 }, turn().ctx));
    await vi.advanceTimersByTimeAsync(5_000);
    expect([byTool.done(), byArg.done(), capped.done()]).toEqual([true, false, false]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect([byArg.done(), capped.done()]).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(51_999);
    expect(capped.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(capped.done()).toBe(true);
    expect(w.tasks.list()).toHaveLength(3);
  });

  it('runInBackground 立即转；让出之前结束的照常在前台回结果，不进登记表', async () => {
    const w = world();
    w.slow();
    const result = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx));
    expect(result.taskId).toMatch(/^bg_/);
    expect(w.tasks.list().map(t => t.status)).toEqual(['running']);
    const quick = w.registry.execute('zz_slow', {}, turn().ctx);
    await flush();
    w.runs[1].finish('zz-quick');
    expect((await quick).content).toBe('zz-quick');
    expect(w.tasks.list()).toHaveLength(1);
  });

  it('前台时回合中止一并中止它；转后台之后回合中止、新消息打断都不动它', async () => {
    const w = world();
    w.slow();
    const foreground = turn();
    const pending = w.registry.execute('zz_slow', {}, foreground.ctx);
    await flush();
    expect(w.runs[0].ctx.signal?.aborted).toBe(false);
    foreground.abort();
    expect(w.runs[0].ctx.signal?.aborted).toBe(true);
    expect(parse(await pending)).toEqual({ aborted: true });

    const byTimer = turn();
    const yielded = w.registry.execute('zz_slow', {}, byTimer.ctx);
    await vi.advanceTimersByTimeAsync(30_000);
    await yielded;
    byTimer.abort();
    const immediate = turn();
    await w.registry.execute('zz_slow', { runInBackground: true }, immediate.ctx);
    immediate.abort();
    expect(w.runs.slice(1).map(r => r.ctx.signal?.aborted)).toEqual([false, false]);
    expect(w.tasks.list().map(t => t.status)).toEqual(['running', 'running']);
  });
});

describe('上限', () => {
  it('第 5 个可转后台调用在执行前被拒、列出在跑的任务，前台在跑的也算数；别的会话不受影响，结束一个就能再起', async () => {
    const w = world();
    w.slow();
    const a = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx));
    const b = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx));
    void w.registry.execute('zz_slow', {}, turn().ctx);
    void w.registry.execute('zz_slow', {}, turn().ctx);
    await flush();
    expect(w.runs).toHaveLength(4);
    const guardedBefore = w.guarded.length;
    const fifth = track(w.registry.execute('zz_slow', {}, turn().ctx));
    await flush();
    expect(fifth.done()).toBe(true);
    const refused = parse(await fifth.value);
    expect(String(refused.error)).toContain('先等待或停掉一个');
    expect(refused.running).toEqual([
      expect.objectContaining({ taskId: a.taskId, tool: 'zz_slow' }),
      expect.objectContaining({ taskId: b.taskId, tool: 'zz_slow' }),
    ]);
    expect(w.runs).toHaveLength(4);
    expect(w.guarded).toHaveLength(guardedBefore);

    void w.registry.execute('zz_slow', {}, turn({ sessionId: OTHER }).ctx);
    await flush();
    expect(w.runs).toHaveLength(5);

    w.runs[0].finish();
    await flush();
    void w.registry.execute('zz_slow', {}, turn().ctx);
    await flush();
    expect(w.runs).toHaveLength(6);
  });

  it('守卫拒绝后让出占的位置', async () => {
    const w = world({ maxPerSession: 1, guard: async ctx => (ctx.args?.text === 'deny' ? 'zz-denied' : null) });
    w.slow();
    expect(parse(await w.registry.execute('zz_slow', { text: 'deny' }, turn().ctx)).error).toBe('zz-denied');
    await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx);
    expect(w.runs).toHaveLength(1);
  });

  it('守卫抛错后同样让出占的位置', async () => {
    const w = world({
      maxPerSession: 1,
      guard: async ctx => {
        if (ctx.args?.text === 'throw') throw new Error('zz-guard-broke');
        return null;
      },
    });
    w.slow();
    await expect(w.registry.execute('zz_slow', { text: 'throw' }, turn().ctx)).rejects.toThrow('zz-guard-broke');
    await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx);
    expect(w.runs).toHaveLength(1);
  });
  it('不在对话回合里的调用不占名额，也不受上限挡：它们不会转后台', async () => {
    const w = world({ maxPerSession: 1 });
    w.slow();
    const outside: ToolCallContext = { sessionId: SESSION, platform: 'mcp', userId: 'zz-client' };
    void w.registry.execute('zz_slow', {}, outside);
    void w.registry.execute('zz_slow', {}, outside);
    await flush();
    expect(w.runs).toHaveLength(2);
    await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx);
    expect(w.runs).toHaveLength(3);
    expect(String(parse(await w.registry.execute('zz_slow', {}, turn().ctx)).error)).toContain('先等待或停掉一个');
    void w.registry.execute('zz_slow', {}, outside);
    await flush();
    expect(w.runs, '名额满了，不在回合里的照常执行').toHaveLength(4);
  });
});

describe('不在对话回合里的调用（没有 turnId 或 callId）', () => {
  const outside: ToolCallContext = { sessionId: 'zz-mcp', platform: 'mcp', userId: 'zz-client' };

  it('runInBackground 直接回错，不执行', async () => {
    const w = world();
    w.slow();
    const result = parse(await w.registry.execute('zz_slow', { runInBackground: true }, outside));
    expect(String(result.error)).toContain('不在对话回合里');
    const noTurn = parse(
      await w.registry.execute('zz_slow', { runInBackground: true }, turn({ turnId: undefined }).ctx),
    );
    expect(String(noTurn.error), '只有 callId、没有 turnId 的同样').toContain('不在对话回合里');
    expect(w.runs).toEqual([]);
  });

  it('到让出时限还没结束就中止并回报已有输出，不登记', async () => {
    const w = world();
    w.slow();
    const call = track(w.registry.execute('zz_slow', {}, outside));
    await flush();
    w.runs[0].ctx.output?.('zz-partial');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.runs[0].ctx.signal?.aborted).toBe(true);
    const result = parse(await call.value);
    expect(String(result.error)).toContain('已中止');
    expect(String(result.error)).toContain('waitSeconds');
    expect(result.output).toBe('zz-partial');
    expect(w.tasks.list()).toEqual([]);
    expect(w.outputs()).toEqual([]);
  });
});

describe('输出口', () => {
  it('有 turnId 与 callId 时转成 tool:output（可转后台与否都一样）；不在回合里的不发', async () => {
    const w = world();
    w.plain('zz_plain', async (_args, ctx) => {
      ctx.output?.('zz-plain-out');
      return 'ok';
    });
    w.slow();
    const t = turn();
    await w.registry.execute('zz_plain', {}, t.ctx);
    const slow = turn();
    const pending = w.registry.execute('zz_slow', {}, slow.ctx);
    await flush();
    w.runs[0].ctx.output?.('zz-slow-out');
    w.runs[0].finish();
    await pending;
    await w.registry.execute('zz_plain', {}, { sessionId: 'zz-mcp', platform: 'mcp' });
    expect(w.outputs()).toEqual([
      { sessionId: SESSION, turnId: t.ctx.turnId, callId: t.ctx.callId, text: 'zz-plain-out' },
      { sessionId: SESSION, turnId: slow.ctx.turnId, callId: slow.ctx.callId, text: 'zz-slow-out' },
    ]);
  });

  it('一次调用推给界面的总量不超过 64 KiB（可转后台与否都一样），不从代理对中间切开', async () => {
    const w = world();
    w.plain('zz_plain', async (_args, ctx) => {
      ctx.output?.('a'.repeat(60_000));
      ctx.output?.(`${'b'.repeat(64 * 1024 - 60_000 - 1)}😀zz-cut`);
      ctx.output?.('zz-after');
      return 'ok';
    });
    w.slow();
    const plain = turn();
    await w.registry.execute('zz_plain', {}, plain.ctx);
    const slow = turn();
    const pending = w.registry.execute('zz_slow', {}, slow.ctx);
    await flush();
    const write = w.runs[0].ctx.output as (text: string) => void;
    write('c'.repeat(64 * 1024));
    write('zz-over');
    w.runs[0].finish();
    await pending;
    const sent = (callId?: string) =>
      w
        .outputs()
        .filter(o => o.callId === callId)
        .map(o => o.text)
        .join('');
    expect(sent(plain.ctx.callId)).toBe(`${'a'.repeat(60_000)}${'b'.repeat(64 * 1024 - 60_000 - 1)}`);
    expect(sent(slow.ctx.callId)).toBe('c'.repeat(64 * 1024));
  });

  it('缓冲只留末尾 64 KiB；output(id, after) 只给新增，after 早于缓冲时 truncated；转后台之后不再发 tool:output', async () => {
    const w = world();
    w.slow();
    const { taskId } = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx));
    const id = String(taskId);
    const write = w.runs[0].ctx.output as (text: string) => void;
    write('a'.repeat(40_000));
    write(`${'b'.repeat(29_991)}\nzz-last\n`);
    const all = w.tasks.output(id);
    expect(all?.end).toBe(70_000);
    expect(all?.text).toHaveLength(64 * 1024);
    expect(all?.text.endsWith('zz-last\n')).toBe(true);
    expect(all?.truncated).toBe(true);
    write('zz-more');
    expect(w.tasks.output(id, 70_000)).toEqual({ text: 'zz-more', end: 70_007, truncated: false });
    expect(w.tasks.output(id, 1_000)?.truncated).toBe(true);
    expect(w.tasks.output('bg_none')).toBeUndefined();
    const [task] = w.tasks.list();
    expect(task.lastLine).toBe('zz-more');
    expect(task.lastOutputAt).toBe(Date.now());
    expect(w.outputs()).toEqual([]);
  });

  it('最后一行与最后输出时间变了发 background:changed，但不写盘', async () => {
    const w = world();
    const store = memoryStore();
    await w.tasks.restore(store.service);
    w.slow();
    await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx);
    await flush();
    const writes = store.writes();
    const before = w.changes().length;
    w.runs[0].ctx.output?.('zz-progress 10%\r');
    await flush();
    expect(w.changes().length).toBe(before + 1);
    expect(w.tasks.list()[0].lastLine).toBe('zz-progress 10%');
    expect(store.writes()).toBe(writes);
  });
});

describe('结局', () => {
  it('结果带 error、或命令的退出码不为 0 为失败；命令的退出码记在任务上，原因只取结果里的 error；结束的留着工具的结果', async () => {
    const w = world();
    w.slow('zz_cmd', { display: { kind: 'command', fields: { command: 'text' }, result: { exitCode: 'exitCode' } } });
    for (let i = 0; i < 3; i++) await w.registry.execute('zz_cmd', { text: 'x', runInBackground: true }, turn().ctx);
    w.runs[0].finish(JSON.stringify({ exitCode: 3 }));
    w.runs[1].finish(JSON.stringify({ error: 'zz-broke' }));
    w.runs[2].finish(JSON.stringify({ exitCode: 0 }));
    await flush();
    expect(w.tasks.list().map(t => [t.status, t.reason, t.exitCode])).toEqual([
      ['failed', undefined, 3],
      ['failed', 'zz-broke', undefined],
      ['completed', undefined, 0],
    ]);
    expect(w.tasks.list()[2].result).toEqual({ content: JSON.stringify({ exitCode: 0 }) });
    const views = parse(await w.registry.execute('background_list', {}, turn().ctx)).tasks as Array<{
      exitCode?: number;
    }>;
    expect(
      views.map(view => view.exitCode),
      '给模型的视图带退出码',
    ).toEqual([3, undefined, 0]);
    expect(w.tasks.list()[0].endedAt).toBe(Date.now());
  });
});

describe('停止、撤回、停用与会话删除', () => {
  it('stop 中止后等落定，落成 stopped，不通知；宽限 3 秒内没停下的如实还在跑', async () => {
    const w = world();
    w.slow();
    w.slow('zz_hang', { hang: true });
    const { taskId } = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx));
    const stopped = await w.tasks.stop(String(taskId));
    expect(w.runs[0].ctx.signal?.aborted).toBe(true);
    expect(stopped?.status).toBe('stopped');
    const hung = parse(await w.registry.execute('zz_hang', { runInBackground: true }, turn().ctx));
    const stopping = track(w.tasks.stop(String(hung.taskId)));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(stopping.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await stopping.value)?.status).toBe('running');
    w.runs[1].finish();
    await flush();
    expect(w.tasks.list().map(t => t.status)).toEqual(['stopped', 'stopped']);
    expect(w.notices()).toEqual([]);
    expect(await w.tasks.stop('bg_none')).toBeUndefined();
  });

  it('被停止的也记下命令的退出码', async () => {
    const w = world();
    w.slow('zz_cmd', {
      hang: true,
      display: { kind: 'command', fields: { command: 'text' }, result: { exitCode: 'exitCode' } },
    });
    const { taskId } = parse(await w.registry.execute('zz_cmd', { text: 'x', runInBackground: true }, turn().ctx));
    const stopping = w.tasks.stop(String(taskId));
    w.runs[0].finish(JSON.stringify({ exitCode: -1 }));
    expect(await stopping).toMatchObject({ status: 'stopped', exitCode: -1 });
  });

  it('工具撤回登记时在跑的（前台与后台）一并中止，后台的落成 aborted，不通知', async () => {
    const w = world();
    const off = w.slow();
    await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx);
    const foreground = w.registry.execute('zz_slow', {}, turn().ctx);
    await flush();
    off();
    expect(w.runs.map(r => r.ctx.signal?.aborted)).toEqual([true, true]);
    expect(parse(await foreground)).toEqual({ aborted: true });
    await flush();
    expect(w.tasks.list()).toEqual([
      expect.objectContaining({ status: 'aborted', reason: expect.stringContaining('撤回') }),
    ]);
    expect(w.notices()).toEqual([]);
  });

  it('plugin-tools 停用（收尾）时在跑的落成 aborted 并写盘，之后落定的不改结局、不通知', async () => {
    const w = world();
    const store = memoryStore();
    await w.tasks.restore(store.service);
    w.slow('zz_slow', { hang: true });
    await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx);
    await w.tasks.close();
    expect(w.runs[0].ctx.signal?.aborted).toBe(true);
    expect(w.tasks.list()[0]).toMatchObject({ status: 'aborted', reason: expect.stringContaining('停用') });
    expect(store.saved()?.tasks[0]).toMatchObject({ status: 'aborted' });
    w.runs[0].finish();
    await flush();
    expect(w.tasks.list()[0].status).toBe('aborted');
    expect(w.notices()).toEqual([]);
  });

  it('会话删除停掉它的任务并删掉登记，不通知；别的会话照常', async () => {
    const w = world();
    w.slow();
    const mine = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx));
    await w.registry.execute('zz_slow', { runInBackground: true }, turn({ sessionId: OTHER }).ctx);
    w.tasks.deleteSession(SESSION);
    expect(w.runs[0].ctx.signal?.aborted).toBe(true);
    expect(w.runs[1].ctx.signal?.aborted).toBe(false);
    await flush();
    expect(w.tasks.list().map(t => t.sessionId)).toEqual([OTHER]);
    expect(w.changes()).toContainEqual({ removed: mine.taskId, sessionId: SESSION });
    w.runs[1].finish();
    await flush();
    expect(w.notices().map(n => n.sessionId)).toEqual([OTHER]);
  });
});

describe('落盘', () => {
  const stored = (over: Record<string, unknown>) => ({
    id: 'bg_old_1',
    sessionId: SESSION,
    kind: 'tool-call',
    label: 'zz_slow',
    call: { tool: 'zz_slow', args: {}, turnId: 'zz-old-turn', callId: 'zz-old-call' },
    status: 'running',
    startedAt: 1_000,
    lastLine: 'zz-old-line',
    lastOutputAt: 2_000,
    starter: { platform: 'webui', userId: 'console' },
    ...over,
  });

  it('读回时还在跑的落成 aborted（原因写 Aalis 重启时还在跑），结束的保持原来的结局；坏条目丢掉并告警', async () => {
    const w = world();
    const store = memoryStore({
      tasks: [
        stored({}),
        stored({ id: 'bg_old_2', status: 'completed', endedAt: 3_000 }),
        { id: 'bg_bad', status: 'weird' },
      ],
    });
    await w.tasks.restore(store.service);
    expect(w.tasks.list().map(t => [t.id, t.status, t.reason])).toEqual([
      ['bg_old_1', 'aborted', 'Aalis 重启时还在跑'],
      ['bg_old_2', 'completed', undefined],
    ]);
    expect(w.tasks.list()[0].endedAt).toBe(2_000);
    expect(w.warnings.some(m => m.includes('1 条'))).toBe(true);
    expect(store.saved()?.tasks.map(t => t.status)).toEqual(['aborted', 'completed']);
    expect(w.tasks.output('bg_old_1')).toEqual({ text: '', end: 0, truncated: false });
  });

  it('只记字段与起它的身份，不记输出与结果；状态变了才写', async () => {
    const w = world();
    const store = memoryStore();
    await w.tasks.restore(store.service);
    w.slow();
    await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx);
    await flush();
    expect(store.saved()?.tasks).toEqual([
      expect.objectContaining({ status: 'running', starter: { platform: 'webui', userId: 'console' } }),
    ]);
    w.runs[0].ctx.output?.('zz-secret-output\n');
    w.runs[0].finish('zz-secret-result');
    await flush();
    const text = JSON.stringify(store.saved());
    expect(text).toContain('completed');
    expect(text).not.toContain('zz-secret-result');
    expect(store.saved()?.tasks[0].lastLine).toBe('zz-secret-output');
    expect(text.split('zz-secret-output')).toHaveLength(2);
  });

  it('每个会话只留在跑的与最近 20 条结束的，删掉的发 removed', async () => {
    const w = world({ maxPerSession: 30 });
    const store = memoryStore();
    await w.tasks.restore(store.service);
    w.slow();
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      ids.push(String(parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx)).taskId));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    for (const run of w.runs.slice(0, 22)) {
      run.finish();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const list = w.tasks.list({ sessionId: SESSION });
    expect(list.filter(t => t.status === 'running').map(t => t.id)).toEqual([ids[22]]);
    expect(list.filter(t => t.status !== 'running').map(t => t.id)).toEqual(ids.slice(2, 22));
    expect(w.changes()).toContainEqual({ removed: ids[0], sessionId: SESSION });
    expect(store.saved()?.tasks).toHaveLength(21);
  });

  it('存储读不出来时告警、只记在内存里，照常工作，不覆盖原文件', async () => {
    const w = world();
    const store = memoryStore(undefined, { broken: true });
    await w.tasks.restore(store.service);
    expect(w.warnings.some(m => m.includes('background-tasks.json'))).toBe(true);
    w.slow();
    await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx);
    w.runs[0].finish();
    await flush();
    expect(w.tasks.list()[0].status).toBe('completed');
    expect(store.writes()).toBe(0);
  });

  it('读回之前起的任务与读回的并存，读回之后一并写盘', async () => {
    const w = world();
    w.slow();
    const early = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx));
    const store = memoryStore({ tasks: [stored({ status: 'completed', endedAt: 3_000 })] });
    await w.tasks.restore(store.service);
    expect(
      w.tasks
        .list()
        .map(t => t.id)
        .sort(),
    ).toEqual(['bg_old_1', String(early.taskId)].sort());
    expect(store.saved()?.tasks).toHaveLength(2);
  });

  it('命令的退出码随登记落盘，读回后照样在', async () => {
    const w = world();
    const store = memoryStore();
    await w.tasks.restore(store.service);
    w.slow('zz_cmd', { display: { kind: 'command', fields: { command: 'text' }, result: { exitCode: 'exitCode' } } });
    await w.registry.execute('zz_cmd', { text: 'x', runInBackground: true }, turn().ctx);
    w.runs[0].finish(JSON.stringify({ exitCode: 3 }));
    await flush();
    expect(store.saved()?.tasks[0].exitCode).toBe(3);
    const after = world();
    await after.tasks.restore(store.service);
    expect(after.tasks.list().map(t => [t.status, t.exitCode])).toEqual([['failed', 3]]);
  });

  it('读回时退出码不是整数的丢掉这一项，任务照留', async () => {
    const w = world();
    await w.tasks.restore(
      memoryStore({ tasks: [stored({ status: 'failed', endedAt: 3_000, exitCode: '2' })] }).service,
    );
    expect(w.tasks.list().map(t => [t.status, t.exitCode])).toEqual([['failed', undefined]]);
  });
});

describe('结束通知', () => {
  const owner = { platform: 'webui', userId: 'console' };
  const cases: Array<{
    name: string;
    ctx: Partial<ToolCallContext>;
    platform: string;
    actor: { platform: string; userId: string };
    callerUserId?: string;
  }> = [
    { name: 'owner 的 WebUI 回合（没有 actor）', ctx: {}, platform: 'webui', actor: owner, callerUserId: 'console' },
    {
      name: '子任务回合（actor 为创建者，userId 为 parent:<id>）',
      ctx: { userId: `parent:${OTHER}`, actor: owner, inbound: { source: 'subtask' } },
      platform: 'webui',
      actor: owner,
      callerUserId: `parent:${OTHER}`,
    },
    {
      name: '定时任务回合（actor 为创建者，没有 userId）',
      ctx: { userId: undefined, actor: owner, inbound: { source: 'scheduler' } },
      platform: 'webui',
      actor: owner,
    },
    {
      name: '自发回合（actor 为无主体，userId 为最后发言的群友）',
      ctx: { sessionId: GROUP, platform: 'onebot', userId: '30001', actor: selfInitiatedActor('onebot') },
      platform: 'onebot',
      actor: { platform: 'onebot', userId: '' },
      callerUserId: '30001',
    },
    {
      name: '群里的群友（没有 actor）',
      ctx: { sessionId: GROUP, platform: 'onebot', userId: '30002' },
      platform: 'onebot',
      actor: { platform: 'onebot', userId: '30002' },
      callerUserId: '30002',
    },
  ];

  for (const c of cases) {
    it(`身份取起它的那次调用：${c.name}`, async () => {
      const w = world();
      w.slow();
      const { ctx } = turn(c.ctx);
      const { taskId } = parse(await w.registry.execute('zz_slow', { text: 'zz-arg', runInBackground: true }, ctx));
      await vi.advanceTimersByTimeAsync(65_000);
      w.runs[0].ctx.output?.('zz-output');
      w.runs[0].finish('zz-result');
      await flush();
      expect(w.notices()).toHaveLength(1);
      const [notice] = w.notices();
      expect(notice.sessionId).toBe(ctx.sessionId);
      expect(notice.platform).toBe(c.platform);
      expect(notice.source).toBe(`bg:${taskId}`);
      expect(notice.actor).toEqual(c.actor);
      expect(notice.hostNotice).toEqual({
        kind: 'background-task',
        id: taskId,
        ...(c.callerUserId !== undefined ? { callerUserId: c.callerUserId } : {}),
      });
      expect(notice.userId).toBeUndefined();
      expect(notice.content).toContain(String(taskId));
      expect(notice.content).toContain('zz_slow');
      expect(notice.content).toContain('已完成');
      expect(notice.content).toContain('1 分 5 秒');
      expect(notice.content).toContain('background_output');
      for (const leaked of ['zz-arg', 'zz-output', 'zz-result']) expect(JSON.stringify(notice)).not.toContain(leaked);
    });
  }

  it('回复引用：hostNotice.replyTo 取起它那次调用的入站消息 id', async () => {
    const w = world();
    w.slow();
    const ctx = turn({ sessionId: GROUP, platform: 'onebot', userId: '30002', inbound: { messageId: 'zz-msg-1' } }).ctx;
    const { taskId } = parse(await w.registry.execute('zz_slow', { runInBackground: true }, ctx));
    w.runs[0].finish();
    await flush();
    expect(w.notices().map(n => n.hostNotice)).toEqual([
      { kind: 'background-task', id: taskId, callerUserId: '30002', replyTo: 'zz-msg-1' },
    ]);
  });

  it('失败的写失败与退出码；工具的错误文字不进通知', async () => {
    const w = world();
    w.slow('zz_cmd', { display: { kind: 'command', fields: { command: 'text' }, result: { exitCode: 'exitCode' } } });
    await w.registry.execute('zz_cmd', { text: 'x', runInBackground: true }, turn().ctx);
    await w.registry.execute('zz_cmd', { text: 'x', runInBackground: true }, turn().ctx);
    w.runs[0].finish(JSON.stringify({ exitCode: 3 }));
    w.runs[1].finish(JSON.stringify({ error: 'zz-tool-error' }));
    await flush();
    const [byCode, byError] = w.notices();
    expect(byCode.content).toContain('失败：退出码 3');
    expect(byError.content).toContain('失败');
    expect(byError.content).not.toContain('zz-tool-error');
  });

  it('由结束通知开的回合里转后台的不再通知，工具结果写明', async () => {
    const w = world();
    w.slow();
    const result = parse(
      await w.registry.execute('zz_slow', { runInBackground: true }, turn({ inbound: { source: 'bg:bg_x_1' } }).ctx),
    );
    expect(result.message).toContain('不再通知');
    w.runs[0].finish();
    await flush();
    expect(w.notices()).toEqual([]);
  });

  it('收到 app:stopping 之后结束的不通知', async () => {
    const w = world();
    w.slow();
    await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx);
    w.tasks.shutdown();
    w.runs[0].finish();
    await flush();
    expect(w.notices()).toEqual([]);
  });
});

describe('四个后台任务工具', () => {
  const NAMES = ['background_list', 'background_output', 'background_wait', 'background_stop'];

  it('只在下发的工具里有可转后台的时才下发，执行面同一判据', async () => {
    const w = world();
    w.plain('zz_plain', async () => 'ok');
    const names = (groups?: string[]) =>
      w.registry.getDefinitions(groups ? { groups } : undefined).map(d => d.function.name);
    expect(names()).toEqual(['zz_plain']);
    expect(w.registry.getAll().map(t => t.name)).toEqual(['zz_plain']);
    expect(parse(await w.registry.execute('background_list', {}, turn().ctx)).error).toContain('未找到');

    w.slow('zz_grouped', { groups: ['zz-g'] });
    expect(names()).toEqual(['zz_plain']);
    expect(names(['zz-g'])).toEqual(['zz_plain', 'zz_grouped', ...NAMES]);
    expect(w.registry.getSummaries({ groups: ['*'] }).map(s => s.name)).toEqual(['zz_plain', 'zz_grouped', ...NAMES]);
    expect(w.registry.getAll().map(t => t.name)).toEqual(['zz_plain', 'zz_grouped', ...NAMES]);
    expect(parse(await w.registry.execute('background_list', {}, turn({ enabledGroups: [] }).ctx)).error).toContain(
      '未找到',
    );
    expect(parse(await w.registry.execute('background_list', {}, turn({ enabledGroups: ['zz-g'] }).ctx)).tasks).toEqual(
      [],
    );
    for (const name of NAMES) {
      const tool = w.registry.getAll().find(t => t.name === name);
      expect(tool).toMatchObject({ visibility: 'public', pluginName: '@aalis/plugin-tools' });
      expect(tool?.confirm).toBeUndefined();
      expect(tool?.risk).toBeUndefined();
    }
  });

  it('别的插件登记同名工具时拒绝并告警', () => {
    const w = world();
    w.slow();
    w.plain('background_list', async () => 'zz-shadow');
    expect(w.registry.getAll().filter(t => t.name === 'background_list')).toEqual([
      expect.objectContaining({ pluginName: '@aalis/plugin-tools' }),
    ]);
    expect(w.warnings.some(m => m.includes('background_list'))).toBe(true);
  });

  describe('只看本会话、同一身份或 owner 起的，别人的回「不存在」', () => {
    const starter = { sessionId: GROUP, platform: 'onebot', userId: '30001' };
    const callers: Array<{ name: string; ctx: Partial<ToolCallContext>; sees: boolean }> = [
      { name: '同一个人', ctx: starter, sees: true },
      {
        name: '同一个人经结束通知开的回合（actor 为起它的身份）',
        ctx: { ...starter, actor: { platform: 'onebot', userId: '30001' }, inbound: { source: 'bg:x' } },
        sees: true,
      },
      { name: '同一房间的另一个人', ctx: { ...starter, userId: '30002' }, sees: false },
      { name: 'owner', ctx: { ...starter, userId: '10001' }, sees: true },
      { name: '同一个人在别的会话', ctx: { ...starter, sessionId: OTHER }, sees: false },
    ];
    for (const caller of callers) {
      it(`${caller.name}：${caller.sees ? '看得到、停得了' : '不存在'}`, async () => {
        const w = world({ isOwner: id => id.platform === 'onebot' && id.userId === '10001' });
        w.slow();
        const { taskId } = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn(starter).ctx));
        const ctx = turn(caller.ctx).ctx;
        const list = parse(await w.registry.execute('background_list', {}, ctx));
        expect((list.tasks as Array<{ taskId: string }>).map(t => t.taskId)).toEqual(caller.sees ? [taskId] : []);
        for (const [tool, args] of [
          ['background_output', { taskId }],
          ['background_wait', { taskIds: [taskId], waitSeconds: 0 }],
          ['background_stop', { taskId }],
        ] as const) {
          const pending = w.registry.execute(tool, args as Record<string, unknown>, ctx);
          await flush();
          const result = parse(await pending);
          if (caller.sees) expect(result.error, tool).toBeUndefined();
          else expect(String(result.error), tool).toContain('不存在');
        }
        expect(w.runs[0].ctx.signal?.aborted).toBe(caller.sees);
      });
    }
  });

  it('background_output 取输出与最后输出时间，带 after 只取新增；结束的带工具的结果与图', async () => {
    const w = world();
    w.slow();
    const { taskId } = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx));
    w.runs[0].ctx.output?.('zz-line-1\n');
    const first = parse(await w.registry.execute('background_output', { taskId }, turn().ctx));
    expect(first).toMatchObject({ taskId, status: 'running', output: 'zz-line-1\n', end: 10, truncated: false });
    expect(first.lastOutputAt).toBe(new Date(Date.now()).toISOString());
    w.runs[0].ctx.output?.('zz-line-2\n');
    const next = parse(await w.registry.execute('background_output', { taskId, after: 10 }, turn().ctx));
    expect(next.output).toBe('zz-line-2\n');
    expect(next.result).toBeUndefined();
    w.runs[0].finish('zz-final');
    await flush();
    const done = parse(await w.registry.execute('background_output', { taskId }, turn().ctx));
    expect(done).toMatchObject({ status: 'completed', result: 'zz-final' });
  });

  it('结束的任务带图的结果：能看图的调用方拿到图，不能的只拿文字', async () => {
    const w = world();
    w.registry.register(
      {
        definition: {
          type: 'function',
          function: { name: 'zz_draw', description: 'zz', parameters: { type: 'object', properties: {} } },
        },
        background: {},
        handler: async () => ({ content: 'zz-drawn', images: ['data:image/png;base64,AA=='] }),
      },
      'zz-test',
    );
    const { taskId } = parse(await w.registry.execute('zz_draw', { runInBackground: true }, turn().ctx));
    await flush();
    const seen = await w.registry.execute('background_output', { taskId }, turn().ctx);
    expect(seen.images).toEqual(['data:image/png;base64,AA==']);
    const blind = await w.registry.execute('background_output', { taskId }, turn({ acceptsImages: false }).ctx);
    expect(blind.images).toBeUndefined();
  });

  it('background_wait 等到都结束即返回；等满 waitSeconds 返回在跑的；回合中止即返回；上限同配置', async () => {
    const w = world({ maxWaitSeconds: 60 });
    w.slow();
    const a = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx)).taskId;
    const b = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx)).taskId;

    const waiting = track(w.registry.execute('background_wait', { taskIds: [a, b], waitSeconds: 100 }, turn().ctx));
    await vi.advanceTimersByTimeAsync(10_000);
    w.runs[0].finish('zz-a');
    await flush();
    expect(waiting.done()).toBe(false);
    w.runs[1].ctx.output?.('zz-b-progress');
    w.runs[1].finish('zz-b');
    await flush();
    expect(waiting.done()).toBe(true);
    const both = parse(await waiting.value);
    expect(both.tasks).toEqual([
      expect.objectContaining({ taskId: a, status: 'completed', result: 'zz-a' }),
      expect.objectContaining({ taskId: b, status: 'completed', result: 'zz-b', lastOutputAt: expect.any(String) }),
    ]);

    const c = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx)).taskId;
    const capped = track(w.registry.execute('background_wait', { taskIds: [c], waitSeconds: 1000 }, turn().ctx));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(capped.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(parse(await capped.value).tasks).toEqual([expect.objectContaining({ taskId: c, status: 'running' })]);

    const t = turn();
    const aborted = track(w.registry.execute('background_wait', { taskIds: [c], waitSeconds: 30 }, t.ctx));
    await flush();
    t.abort();
    await flush();
    expect(aborted.done()).toBe(true);
  });

  it('background_stop 等落定再如实回报，停后不通知', async () => {
    const w = world();
    w.slow();
    const { taskId } = parse(await w.registry.execute('zz_slow', { runInBackground: true }, turn().ctx));
    const stopped = parse(await w.registry.execute('background_stop', { taskId }, turn().ctx));
    expect(stopped).toMatchObject({ taskId, status: 'stopped' });
    const again = parse(await w.registry.execute('background_stop', { taskId }, turn().ctx));
    expect(again).toMatchObject({ taskId, status: 'stopped' });
    await flush();
    expect(w.notices()).toEqual([]);
  });
});

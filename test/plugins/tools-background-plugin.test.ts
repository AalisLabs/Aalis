import { afterEach, describe, expect, it } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import type { SessionInfo } from '../../packages/api-session-manager/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import {
  backgroundTasks,
  type RegisteredTool,
  type ToolCallContext,
  type ToolExecutionResult,
  tools,
} from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, lifecycle, provide, services } from '../../packages/core/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideEvents } from '../fixtures/hubs.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// plugin-tools 的转后台接线：配置的两项上限、backgroundTasks 服务、会话删除事件与应用停机、
// 停用时落成 aborted 并写进插件数据、停用之后不再接可转后台的调用、storage 晚于本插件上线时照样读回。
// 执行器本身的规则见 tools-background.test.ts，重启读回见 test/integration/background-restart.test.ts。
// ════════════════════════════════════════════════════════════

const SESSION = 'zz-6b-plugin-session';
const FILE = 'pluginData:/tools/background-tasks.json';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

/** 只有 pluginData 一个根的内存存储 */
function pluginDataStorage(files = new Map<string, string>()): StorageService {
  return {
    listRoots: () => [
      {
        name: 'pluginData',
        label: '插件数据',
        kind: 'pluginData',
        browsable: false,
        readable: true,
        writable: true,
        deletable: true,
      },
    ],
    async readFile(uri: string) {
      const text = files.get(uri);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      return text;
    },
    async writeFile(uri: string, data: string | Buffer) {
      files.set(uri, String(data));
    },
  } as unknown as StorageService;
}

interface Run {
  ctx: ToolCallContext;
  finish(result?: string): void;
}

async function start(config: Record<string, unknown> = {}, opts: { storage?: StorageService } = {}) {
  const { app } = hostedApp();
  provideEvents(app);
  apps.push(app);
  const host = app.bind({ provide, events, tools, backgroundTasks });
  if (opts.storage) host.provide.use(storage, opts.storage);
  await app.plugins.register(toolsPlugin, config);
  await app.plugins.idle();
  const runs: Run[] = [];
  const tool: Omit<RegisteredTool, 'pluginName'> = {
    definition: {
      type: 'function',
      function: { name: 'zz_slow', description: 'zz', parameters: { type: 'object', properties: {} } },
    },
    background: {},
    handler: (_args, ctx) =>
      new Promise(resolve => {
        runs.push({ ctx, finish: (result = 'zz-done') => resolve(result) });
      }),
  };
  host.tools.use.register(tool);
  const notices: IncomingMessage[] = [];
  host.events.use.on('inbound:message', message => {
    notices.push(message);
  });
  let seq = 0;
  const run = async (args: Record<string, unknown>) => {
    seq++;
    const result: ToolExecutionResult = await host.tools.use.execute(
      'zz_slow',
      args,
      toolRequest({
        sessionId: SESSION,
        platform: 'webui',
        userId: 'console',
        enabledGroups: [],
        inbound: {},
        turnId: `zz-turn-${seq}`,
        callId: `zz-call-${seq}`,
      }),
    );
    return JSON.parse(result.content) as Record<string, unknown>;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  return { app, host, runs, notices, run, settle, tasks: () => host.backgroundTasks.use };
}

describe('plugin-tools 的转后台接线', () => {
  it('提供 backgroundTasks；配置的每会话上限生效', async () => {
    const w = await start({ background: { maxPerSession: 1 } });
    const first = await w.run({ runInBackground: true });
    expect(
      w
        .tasks()
        .list()
        .map(t => t.id),
    ).toEqual([first.taskId]);
    const refused = await w.run({ runInBackground: true });
    expect(String(refused.error)).toContain('上限 1');
    expect(w.runs).toHaveLength(1);
  });

  it('前台最多等待超出计时器能表示的范围时不认，回落默认值', async () => {
    const w = await start({ background: { maxWaitSeconds: 9_999_999 } });
    const [def] = w.host.tools.use.getDefinitions();
    const { description } = def.function.parameters.properties.waitSeconds as { description: string };
    expect(description).toContain('最多 600');
  });

  it('会话删除事件停掉并删掉登记；归档（会话更新为 archived）不停', async () => {
    const w = await start();
    await w.run({ runInBackground: true });
    await w.host.events.use.emit('session:updated', { id: SESSION, status: 'archived' } as SessionInfo);
    expect(
      w
        .tasks()
        .list()
        .map(t => t.status),
    ).toEqual(['running']);
    expect(w.runs[0].ctx.signal?.aborted).toBe(false);
    await w.host.events.use.emit('session:deleted', SESSION);
    expect(w.runs[0].ctx.signal?.aborted).toBe(true);
    expect(w.tasks().list()).toEqual([]);
  });

  it('正常结束通知发起它的会话；停机途中、工具注册表还没开始收尾时结束的照常通知', async () => {
    const w = await start();
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    let reached!: () => void;
    const draining = new Promise<void>(resolve => (reached = resolve));
    // 用着工具注册表的插件：停机时它先收尾，卡在收尾里的这段时间工具注册表还没开始收尾
    await w.app.plugin(
      definePlugin({
        name: 'zz-tool-user',
        uses: { lifecycle, tools },
        apply: caps =>
          void caps.lifecycle.use.onDrain(() => {
            reached();
            return held;
          }),
      }),
    );
    await w.app.plugins.idle();
    await w.run({ runInBackground: true });
    await w.run({ runInBackground: true });
    w.runs[0].finish();
    await w.settle();
    expect(w.notices).toHaveLength(1);
    const stopping = w.app.stop();
    await draining;
    w.runs[1].finish();
    await w.settle();
    expect(
      w
        .tasks()
        .list()
        .map(task => task.status),
    ).toEqual(['completed', 'completed']);
    expect(w.notices).toHaveLength(2);
    release();
    await stopping;
  });

  it('应用停机时在跑的落成 aborted 并写进插件数据', async () => {
    const files = new Map<string, string>();
    const w = await start({}, { storage: pluginDataStorage(files) });
    await w.run({ runInBackground: true });
    await w.app.stop();
    const saved = JSON.parse(files.get(FILE) ?? '{}') as { tasks: Array<Record<string, unknown>> };
    expect(saved.tasks.map(t => [t.status, t.reason])).toEqual([
      ['aborted', expect.objectContaining({ source: 'Aalis 停止或工具注册表停用时还在跑' })],
    ]);
  });

  it('停用时在跑的落成 aborted 并写进插件数据', async () => {
    const files = new Map<string, string>();
    const w = await start({}, { storage: pluginDataStorage(files) });
    await w.run({ runInBackground: true });
    await w.run({ runInBackground: true });
    w.runs[1].finish();
    await w.settle();
    await w.app.plugins.unload(toolsPlugin.name);
    const saved = JSON.parse(files.get(FILE) ?? '{}') as { tasks: Array<Record<string, unknown>> };
    expect(saved.tasks.map(t => [t.status, t.reason])).toEqual([
      ['aborted', expect.objectContaining({ source: 'Aalis 停止或工具注册表停用时还在跑' })],
      ['completed', undefined],
    ]);
  });

  // 收尾到撤回登记之间执行器仍对外可用：直接登记在执行器上的工具不随宿主的门面撤回，停用之后仍查得到，代表这段窗口
  it('停用之后拿着旧执行器调可转后台的工具：不执行，回正在停用', async () => {
    const w = await start();
    const registry = w.app.bind({ services }).services.use.get(tools);
    if (!registry) throw new Error('执行器未提供');
    const ran: string[] = [];
    registry.register(
      {
        definition: {
          type: 'function',
          function: { name: 'zz_kept', description: 'zz', parameters: { type: 'object', properties: {} } },
        },
        background: {},
        handler: async () => {
          ran.push('zz_kept');
          return 'zz-done';
        },
      },
      'zz-test',
      'zz-test',
    );
    await w.app.plugins.unload(toolsPlugin.name);
    const result = await registry.execute(
      'zz_kept',
      {},
      toolRequest({ sessionId: SESSION, platform: 'webui', userId: 'console', enabledGroups: [], inbound: {} }),
    );
    expect(JSON.parse(result.content)).toEqual({ error: expect.stringContaining('停用') });
    expect(ran).toEqual([]);
  });

  it('storage 晚于 plugin-tools 上线时照样读回', async () => {
    const files = new Map<string, string>([
      [
        FILE,
        JSON.stringify({
          tasks: [
            {
              id: 'bg_late_1',
              sessionId: SESSION,
              kind: 'tool-call',
              label: 'zz_slow',
              call: { tool: 'zz_slow', args: {}, turnId: 't', callId: 'c' },
              status: 'completed',
              startedAt: 1,
              endedAt: 2,
            },
          ],
        }),
      ],
    ]);
    const w = await start();
    expect(w.tasks().list()).toEqual([]);
    w.host.provide.use(storage, pluginDataStorage(files));
    await w.settle();
    expect(
      w
        .tasks()
        .list()
        .map(t => t.id),
    ).toEqual(['bg_late_1']);
  });
});

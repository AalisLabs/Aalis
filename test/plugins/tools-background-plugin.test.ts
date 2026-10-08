import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import type { SessionInfo } from '../../packages/api-session-manager/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import {
  backgroundTasks,
  type RegisteredTool,
  type ToolCallContext,
  type ToolExecutionResult,
  tools,
} from '../../packages/api-tools/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// plugin-tools 的转后台接线：配置的两项上限、backgroundTasks 服务、会话删除与 app:stopping 两个事件、
// 停用时落成 aborted 并写进插件数据、storage 晚于本插件上线时照样读回、判 owner 经 authority。
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
  apps.push(app);
  const host = app.bind({ provide, events, tools, backgroundTasks });
  if (opts.storage) host.provide(storage, opts.storage);
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
  host.tools.register(tool);
  const notices: IncomingMessage[] = [];
  host.events.on('inbound:message', message => {
    notices.push(message);
  });
  let seq = 0;
  const run = async (args: Record<string, unknown>, over: Partial<ToolCallContext> = {}) => {
    seq++;
    const result: ToolExecutionResult = await host.tools.require().execute('zz_slow', args, {
      sessionId: SESSION,
      platform: 'webui',
      userId: 'console',
      enabledGroups: [],
      inbound: {},
      turnId: `zz-turn-${seq}`,
      callId: `zz-call-${seq}`,
      ...over,
    });
    return JSON.parse(result.content) as Record<string, unknown>;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  return { app, host, runs, notices, run, settle, tasks: () => host.backgroundTasks.require() };
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
    const [def] = w.host.tools.require().getDefinitions();
    const { description } = def.function.parameters.properties.waitSeconds as { description: string };
    expect(description).toContain('最多 600');
  });

  it('会话删除事件停掉并删掉登记；归档（会话更新为 archived）不停', async () => {
    const w = await start();
    await w.run({ runInBackground: true });
    await w.host.events.emit('session:updated', { id: SESSION, status: 'archived' } as SessionInfo);
    expect(
      w
        .tasks()
        .list()
        .map(t => t.status),
    ).toEqual(['running']);
    expect(w.runs[0].ctx.signal?.aborted).toBe(false);
    await w.host.events.emit('session:deleted', SESSION);
    expect(w.runs[0].ctx.signal?.aborted).toBe(true);
    expect(w.tasks().list()).toEqual([]);
  });

  it('正常结束通知起它的会话；收到 app:stopping 之后结束的不通知', async () => {
    const w = await start();
    await w.run({ runInBackground: true });
    await w.run({ runInBackground: true });
    w.runs[0].finish();
    await w.settle();
    expect(w.notices).toHaveLength(1);
    await w.host.events.emit('app:stopping');
    w.runs[1].finish();
    await w.settle();
    expect(w.notices).toHaveLength(1);
  });

  it('判 owner 经 authority：owner 看得到别人起的任务', async () => {
    const w = await start();
    w.host.provide(authority, { isOwner: (_platform: string, userId?: string) => userId === '10001' } as never);
    await w.run({ runInBackground: true }, { platform: 'onebot', userId: '30001' });
    const list = async (userId: string) => {
      const result = await w.host.tools
        .require()
        .execute(
          'background_list',
          {},
          { sessionId: SESSION, platform: 'onebot', userId, enabledGroups: [], inbound: {} },
        );
      return (JSON.parse(result.content).tasks as unknown[]).length;
    };
    expect(await list('30002')).toBe(0);
    expect(await list('10001')).toBe(1);
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
      ['aborted', expect.stringContaining('停用')],
      ['completed', undefined],
    ]);
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
              starter: { platform: 'webui', userId: 'console' },
            },
          ],
        }),
      ],
    ]);
    const w = await start();
    expect(w.tasks().list()).toEqual([]);
    w.host.provide(storage, pluginDataStorage(files));
    await w.settle();
    expect(
      w
        .tasks()
        .list()
        .map(t => t.id),
    ).toEqual(['bg_late_1']);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { backgroundTasks, type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, provide, services } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type MemoryFiles, memoryStorage } from '../fixtures/memory-files.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { client } from '../fixtures/session-client.js';

// ════════════════════════════════════════════════════════════
// 重启之后的后台任务：真的 agent 在一轮里发起两次可转后台的调用，都转到后台；一个在重启之前正常结束，一个还在跑。
// 停掉整个应用，再以同一份插件数据、同一份存档与同一个宿主目录起第二个应用：
// 还在跑的在停机时落成 aborted，已结束的保持原来的结局；历史里两张工具卡的 taskId 都在 background/list 里，
// 状态与登记表一致。
// ════════════════════════════════════════════════════════════

const BG = 'zz_restart_bg';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const callBackground = (id: string, command: string) => ({
  id,
  type: 'function' as const,
  function: { name: BG, arguments: JSON.stringify({ command, runInBackground: true }) },
});

describe('重启之后的后台任务', () => {
  it('重启前在跑的落成 aborted，已结束的保持原来的结局；历史里工具卡的 taskId 在 background/list 里，状态与登记表一致', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aalis-background-restart-'));
    homes.push(home);
    /** 插件数据：前后两个应用共用这一份 */
    const files: MemoryFiles = new Map();
    const responses: ChatResponse[] = [
      { content: null, toolCalls: [callBackground('model-1', 'make build'), callBackground('model-2', 'npm run dev')] },
      { content: '两个都放到后台了' },
    ];
    /** 起一个应用。archive 给了就用它当存档（前一个应用留下的那一份），不给就装内存记忆插件 */
    const boot = async (archive?: MemoryService) => {
      const app = new App({ name: 'T', logLevel: 'error', logger: silent });
      apps.push(app);
      provideHostPaths(app, home);
      await registerHubs(app);
      const host = app.bind({ provide, services, tools, backgroundTasks, agent, sessionManager, sessionProtocol });
      host.provide.use(storage, memoryStorage(files));
      if (archive) host.provide.use(memory, archive);
      else await app.plugin(memoryInMemoryPlugin);
      await app.plugin(createMockLLMPlugin({ responses }));
      await app.plugin(messageArchivePlugin, { debugLogs: false });
      await app.plugin(toolsPlugin, {});
      await app.plugin(agentPlugin, { systemPrompt: 'test' });
      await app.plugin(sessionManagerPlugin, {});
      await app.plugin(sessionServerPlugin, {});
      await app.plugins.idle();
      return { app, host };
    };
    const { app, host } = await boot();
    const archive = host.services.use.get(memory);
    if (!archive) throw new Error('存档未提供');
    const runs: Array<{ ctx: ToolCallContext; finish(result: string): void }> = [];
    host.tools.use.register({
      definition: {
        type: 'function',
        function: {
          name: BG,
          description: '可转后台的测试工具',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
      background: {},
      display: { kind: 'command', fields: { command: 'command' }, result: { exitCode: 'exitCode' } },
      handler: (_args, ctx) =>
        new Promise<string>(resolve => {
          runs.push({ ctx, finish: resolve });
          ctx.signal?.addEventListener('abort', () => resolve(JSON.stringify({ error: '已中止' })), { once: true });
        }),
    });
    const sm = host.sessionManager.use;
    const s = await sm.createSession({ name: 'S' });
    await sm.updateSessionTitle(s.id, 'S');

    await host.agent.use.handleMessage({
      content: '构建并起开发服务器',
      sessionId: s.id,
      platform: 'webui',
      userId: 'console',
    });
    expect(runs).toHaveLength(2);
    runs[0].finish(JSON.stringify({ exitCode: 0 }));
    await vi.waitFor(() =>
      expect(host.backgroundTasks.use.list().map(task => task.status)).toEqual(['completed', 'running']),
    );

    await app.stop();
    expect(runs[1].ctx.signal?.aborted, '停机时在跑的随之中止').toBe(true);
    const restarted = await boot(archive);

    const registry = () => restarted.host.backgroundTasks.use.list();
    await vi.waitFor(() => expect(registry()).toHaveLength(2));
    expect(registry().map(task => [task.call.tool, task.status, toSource(task.reason)])).toEqual([
      [BG, 'completed', undefined],
      [BG, 'aborted', 'Aalis 停止或工具注册表停用时还在跑'],
    ]);

    const c = client(restarted.host.sessionProtocol.use);
    await c.init();
    const { tasks } = await c.call('background/list', {});
    const cards = (await c.subscribe(s.id)).snapshot.items.filter(item => item.kind === 'tool-call');
    expect(cards).toHaveLength(2);
    expect(
      cards.map(card => {
        const task = card.kind === 'tool-call' ? tasks.find(t => t.id === card.taskId) : undefined;
        return [card.kind === 'tool-call' ? card.args.command : undefined, task?.status];
      }),
    ).toEqual([
      ['make build', 'completed'],
      ['npm run dev', 'aborted'],
    ]);
    expect(tasks.map(task => [task.id, task.status])).toEqual(registry().map(task => [task.id, task.status]));
    expect(tasks[0].exitCode, '重启前结束的命令照样带退出码').toBe(0);
  });
});

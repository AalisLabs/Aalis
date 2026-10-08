import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { backgroundTasks, type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, events, type Logger, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { memoryStorage } from '../fixtures/paper.js';
import { client } from '../fixtures/session-client.js';

// ════════════════════════════════════════════════════════════
// 重启之后的后台任务：真的 agent 在一轮里起两次可转后台的调用，都转到后台；一个在重启之前正常结束，一个还在跑。
// 停机（app:stopping 之后停用工具注册表与会话服务）再以同一份插件数据与同一份存档重新激活它们：
// 还在跑的落成 aborted（重启时还在跑），已结束的保持原来的结局；历史里两张工具卡的 taskId 都在 background/list 里，
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
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    apps.push(app);
    const home = mkdtempSync(join(tmpdir(), 'aalis-background-restart-'));
    homes.push(home);
    provideHostPaths(app, home);
    await registerHubs(app);
    const host = app.bind({ provide, events, tools, backgroundTasks, agent, sessionManager, sessionProtocol });
    /** 插件数据：两次激活共用这一份 */
    host.provide(storage, memoryStorage(new Map()));
    const responses: ChatResponse[] = [
      { content: null, toolCalls: [callBackground('model-1', 'make build'), callBackground('model-2', 'npm run dev')] },
      { content: '两个都放到后台了' },
    ];
    await app.plugin(createMockLLMPlugin({ responses }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(toolsPlugin, {});
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugin(sessionManagerPlugin, {});
    await app.plugin(sessionServerPlugin, {});
    await app.plugins.idle();
    const runs: Array<{ ctx: ToolCallContext; finish(result: string): void }> = [];
    host.tools.register({
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
    const sm = host.sessionManager.require();
    const s = await sm.createSession({ name: 'S' });
    await sm.updateSessionTitle(s.id, 'S');

    await host.agent
      .require()
      .handleMessage({ content: '构建并起开发服务器', sessionId: s.id, platform: 'webui', userId: 'console' });
    expect(runs).toHaveLength(2);
    runs[0].finish(JSON.stringify({ exitCode: 0 }));
    await vi.waitFor(() =>
      expect(
        host.backgroundTasks
          .require()
          .list()
          .map(task => task.status),
      ).toEqual(['completed', 'running']),
    );

    await host.events.emit('app:stopping');
    await app.plugins.unload(sessionServerPlugin.name);
    await app.plugins.unload(toolsPlugin.name);
    expect(runs[1].ctx.signal?.aborted, '停用时在跑的随之中止').toBe(true);
    await app.plugin(toolsPlugin, {});
    await app.plugin(sessionServerPlugin, {});
    await app.plugins.idle();

    const registry = () => host.backgroundTasks.require().list();
    await vi.waitFor(() => expect(registry()).toHaveLength(2));
    expect(registry().map(task => [task.call.tool, task.status, task.reason])).toEqual([
      [BG, 'completed', undefined],
      [BG, 'aborted', 'Aalis 重启时还在跑'],
    ]);

    const c = client(host.sessionProtocol.require());
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
  });
});

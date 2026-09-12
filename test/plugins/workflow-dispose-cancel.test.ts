import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useToolService } from '../../packages/api-tools/src/index.js';
import type { WorkflowRun, WorkflowService } from '../../packages/api-workflow/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as cronEngineModule from '../../packages/plugin-cron-engine/src/index.js';
import * as storageLocalModule from '../../packages/plugin-storage-local/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';
import * as workflowModule from '../../packages/plugin-workflow/src/index.js';

// ════════════════════════════════════════════════════════════
// 拆卸时在飞 run 必须真被取消：onDispose 只 cancelTokens.clear() 的话，
// 在飞 run 手里握的是自己的 token 引用——清表清不到它，于是它会用已 dispose
// 的 ctx 跑完剩余节点、emit 事件，并把结果写回旧 RunStore 的历史快照。
// 驱动面全部走公开面：真 fs storage + 真 tools + app.plugins.unload（生产卸载路径）。
// ════════════════════════════════════════════════════════════

describe('workflow 拆卸取消在飞 run（真 fs + 真卸载）', () => {
  let base: string;
  let app: App;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-wf-dispose-'));
    mkdirSync(join(base, 'data'), { recursive: true });
    mkdirSync(join(base, 'workspace'), { recursive: true });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('unload 后被阻塞的首节点放行：下游节点 skipped、run 记 cancelled', async () => {
    app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(storageLocalModule as never, {
      roots: ['data', 'workspace'].map(name => ({
        name,
        path: join(base, name),
        label: name,
        kind: name === 'data' ? 'data' : 'workspace',
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      })),
    });
    await app.ctx.useModule(toolsModule as never, {});
    await app.ctx.useModule(cronEngineModule as never, {});

    // gate：卡住第一个节点，直到测试放行；downstream：只记录"我被跑了"
    let gateEntered!: () => void;
    const entered = new Promise<void>(r => {
      gateEntered = r;
    });
    let release!: () => void;
    const released = new Promise<void>(r => {
      release = r;
    });
    let downstreamRuns = 0;
    const tools = useToolService(app.ctx);
    tools.register({
      definition: {
        type: 'function',
        function: { name: 'zz_gate', description: '闸门', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => {
        gateEntered();
        await released;
        return { content: 'gate-ok' };
      },
    });
    tools.register({
      definition: {
        type: 'function',
        function: { name: 'zz_downstream', description: '下游', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => {
        downstreamRuns++;
        return { content: 'downstream-ok' };
      },
    });

    // 经 app.plugin 注册（而非 ctx.useModule）才进插件注册表，unload 才拿得到它
    await app.plugin(workflowModule as never, { enableTools: false });
    await app.plugins.idle();
    const svc = app.ctx.getService<WorkflowService>('workflow')!;
    await svc.defineWorkflow(
      {
        id: 'zz-dispose',
        trigger: { type: 'manual' },
        nodes: [
          { id: 'a', type: 'tool', tool: 'zz_gate' },
          { id: 'b', type: 'tool', tool: 'zz_downstream', deps: ['a'] },
        ],
      },
      { persist: false },
    );

    const runPromise = svc.runWorkflow('zz-dispose') as Promise<WorkflowRun>;
    await entered; // 第一个节点已进入执行，run 在飞

    await app.plugins.unload('@aalis/plugin-workflow');
    release();
    const run = await runPromise;

    expect(downstreamRuns, '拆卸后不应再调度新节点').toBe(0);
    expect(run.nodes.find(n => n.id === 'b')?.status).toBe('skipped');
    expect(run.status).toBe('cancelled');
  });
});

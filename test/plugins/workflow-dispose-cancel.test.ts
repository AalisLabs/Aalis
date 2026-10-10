import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { type WorkflowRun, workflow } from '../../packages/api-workflow/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 拆卸时在飞 run 必须真被取消：onDispose 只 cancelTokens.clear() 的话，
// 在飞 run 手里握的是自己的 token 引用——清表清不到它，于是它会在已关闭的激活上
// 跑完剩余节点、emit 事件，并把结果写回旧 RunStore 的历史快照。
// 拆卸还要等它收尾：被取消的 run 也要把终态写进运行历史，否则这笔写入落在拆卸返回之后，
// bounce 时会盖掉新实例的运行历史与 once 记账。
// 驱动面全部走公开面：真 fs storage + 真 tools + app.plugins.unload（生产卸载路径）。
// ════════════════════════════════════════════════════════════

/** 首节点进入后卡住的时长：远长于拆卸本身，拆卸不等在飞 run 就会先于它返回 */
const GATE_MS = 300;

/** 插件停在 pending（required 依赖缺席）时会让整条用例悄悄空转，装载后当场判死 */
function assertActive(app: App, ids: string[]): void {
  for (const id of ids) {
    const state = app.plugins.getPlugin(id)?.state;
    if (state !== 'active') throw new Error(`插件 "${id}" 未激活（state=${state}）`);
  }
}

describe('workflow 拆卸取消在飞 run（真 fs + 真卸载）', () => {
  let base: string;
  let app: App;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-wf-dispose-'));
    mkdirSync(join(base, 'workspace'), { recursive: true });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('unload 取消在飞 run 并等它收尾：返回时 run 的 cancelled 终态已落盘，下游节点 skipped', async () => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.plugin(storageLocalPlugin, {
      // data:/ 是内置根（家目录的 state/），用户 roots 里只声明工作根
      roots: [
        {
          name: 'workspace',
          path: join(base, 'workspace'),
          label: 'workspace',
          kind: 'workspace',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    await app.plugin(toolsPlugin, {});
    await app.plugin(cronEnginePlugin, {});

    // gate：第一个节点进入后卡 GATE_MS；downstream：只记录"我被跑了"
    let gateEntered!: () => void;
    const entered = new Promise<void>(r => {
      gateEntered = r;
    });
    let downstreamRuns = 0;
    // 宿主侧登记测试工具：与插件同一套描述符装配，登记归属根激活
    const { tools } = app.bind({ tools: toolsService });
    tools.use.register({
      definition: {
        type: 'function',
        function: { name: 'zz_gate', description: '闸门', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => {
        gateEntered();
        await new Promise(r => setTimeout(r, GATE_MS));
        return { content: 'gate-ok' };
      },
    });
    tools.use.register({
      definition: {
        type: 'function',
        function: { name: 'zz_downstream', description: '下游', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => {
        downstreamRuns++;
        return { content: 'downstream-ok' };
      },
    });

    await app.plugin(workflowPlugin, { enableTools: false });
    await app.plugins.idle();
    assertActive(app, [
      '@aalis/plugin-storage-local',
      '@aalis/plugin-tools',
      '@aalis/plugin-cron-engine',
      '@aalis/plugin-workflow',
    ]);
    const host = app.bind({ services });
    const svc = host.services.use.get(workflow)!;
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
    const { runs } = JSON.parse(readFileSync(join(base, 'state', 'workflow-runs.json'), 'utf-8')) as {
      runs: WorkflowRun[];
    };
    expect(runs.find(r => r.workflowId === 'zz-dispose')?.status, '拆卸返回前终态已落盘').toBe('cancelled');
    const run = await runPromise;

    expect(downstreamRuns, '拆卸后不应再调度新节点').toBe(0);
    expect(run.nodes.find(n => n.id === 'b')?.status).toBe('skipped');
    expect(run.status).toBe('cancelled');
  });
});

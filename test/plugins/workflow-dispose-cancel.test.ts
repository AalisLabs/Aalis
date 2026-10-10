import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RegisteredTool, tools as toolsService } from '../../packages/api-tools/src/index.js';
import {
  type NodeSpec,
  type WorkflowRun,
  type WorkflowService,
  workflow,
} from '../../packages/api-workflow/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 拆卸时在飞 run 必须真被取消：只清掉登记表的话，在飞 run 手里仍握着自己的取消信号，
// 它会在已关闭的激活上跑完剩余节点、emit 事件，并把结果写回旧 RunStore 的历史快照。
// 拆卸还要等它收尾：被取消的 run 也要把终态写进运行历史，否则这笔写入落在拆卸返回之后，
// bounce 时会盖掉新实例的运行历史与 once 记账。
// 既然拆卸要等，取消就得打断阻塞中的节点：一小时的 wait、等不来回复的 agent 节点会让旧实例超过宽限、
// 滞留不退，同一 id 的新实例要等它落定才起，插件在整段等待里都不可用。
// 驱动面全部走公开面：真 fs storage + 真 tools + app.plugins.unload / bounce（生产卸载与重启路径）。
// ════════════════════════════════════════════════════════════

/** 首节点进入后卡住的时长：远长于拆卸本身，拆卸不等在飞 run 就会先于它返回 */
const GATE_MS = 300;
/** 拆卸宽限：长于 GATE_MS，远短于阻塞节点的一小时 */
const GRACE_MS = 1000;
const WORKFLOW = '@aalis/plugin-workflow';

/** 测试工具的登记形状（pluginName 由登记口填） */
type TestTool = Omit<RegisteredTool, 'pluginName'>;

const tool = (name: string, handler: RegisteredTool['handler']): TestTool => ({
  definition: {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
  },
  handler,
});

describe('workflow 拆卸取消在飞 run（真 fs + 真卸载）', () => {
  let base: string;
  let app: App;

  /** 装好 storage / tools / cron-engine / workflow；测试工具在 workflow 装载前由宿主登记（归属根激活） */
  async function boot(testTools: TestTool[]): Promise<WorkflowService> {
    app = new App({ name: 'T', logLevel: 'error', disposeTimeoutMs: GRACE_MS });
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
    const { tools } = app.bind({ tools: toolsService });
    for (const t of testTools) tools.use.register(t);
    await app.plugin(workflowPlugin, { enableTools: false });
    await app.plugins.idle();
    // 插件停在 pending（required 依赖缺席）时会让整条用例悄悄空转，装载后当场判死
    for (const id of ['@aalis/plugin-storage-local', '@aalis/plugin-tools', '@aalis/plugin-cron-engine', WORKFLOW]) {
      const state = app.plugins.getPlugin(id)?.state;
      if (state !== 'active') throw new Error(`插件 "${id}" 未激活（state=${state}）`);
    }
    return app.bind({ services }).services.use.get(workflow)!;
  }

  /** runsFile 里该 workflow 的那条记录 */
  const recorded = (workflowId: string): WorkflowRun | undefined =>
    (JSON.parse(readFileSync(join(base, 'state', 'workflow-runs.json'), 'utf-8')) as { runs: WorkflowRun[] }).runs.find(
      r => r.workflowId === workflowId,
    );

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-wf-dispose-'));
    mkdirSync(join(base, 'workspace'), { recursive: true });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('unload 取消在飞 run 并等它收尾：返回时 run 的 cancelled 终态已落盘，下游节点 skipped', async () => {
    // gate：第一个节点进入后卡 GATE_MS，不理会中止信号；downstream：只记录"我被跑了"
    let gateEntered!: () => void;
    const entered = new Promise<void>(r => {
      gateEntered = r;
    });
    let downstreamRuns = 0;
    const svc = await boot([
      tool('zz_gate', async () => {
        gateEntered();
        await new Promise(r => setTimeout(r, GATE_MS));
        return 'gate-ok';
      }),
      tool('zz_downstream', async () => {
        downstreamRuns++;
        return 'downstream-ok';
      }),
    ]);
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

    const runPromise = svc.runWorkflow('zz-dispose');
    await entered; // 第一个节点已进入执行，run 在飞

    await app.plugins.unload(WORKFLOW);
    expect(recorded('zz-dispose')?.status, '拆卸返回前终态已落盘').toBe('cancelled');
    const run = await runPromise;

    expect(downstreamRuns, '拆卸后不应再调度新节点').toBe(0);
    expect(run.nodes.find(n => n.id === 'b')?.status).toBe('skipped');
    expect(run.status).toBe('cancelled');
  });

  const blocking: Array<[string, NodeSpec]> = [
    ['wait', { id: 'a', type: 'wait', seconds: 3600 }],
    // 没装 agent：回复永远不来，只能等满 timeoutSeconds
    ['agent', { id: 'a', type: 'agent', instruction: '等一个不会来的回复', timeoutSeconds: 3600 }],
    // 工具只在中止信号断开时返回
    ['tool', { id: 'a', type: 'tool', tool: 'zz_until_abort' }],
  ];

  it.each(blocking)('%s 节点阻塞中被 bounce：等待被打断，新实例照常上线', async (_, node) => {
    const svc = await boot([
      tool(
        'zz_until_abort',
        (_args, ctx) => new Promise(resolve => ctx.signal?.addEventListener('abort', () => resolve('aborted'))),
      ),
    ]);
    await svc.defineWorkflow({ id: 'zz-block', trigger: { type: 'manual' }, nodes: [node] }, { persist: false });
    const runPromise = svc.runWorkflow('zz-block');
    await new Promise(r => setTimeout(r, 50)); // 节点已进入阻塞

    expect(await app.plugins.bounce(WORKFLOW)).toBe(true);
    await app.plugins.idle();
    const status = app.plugins.getStatus().find(p => p.instanceId === WORKFLOW);
    expect(status?.lingering, '旧实例超过宽限仍未停下').toBeUndefined();
    expect(status?.state).toBe('active');
    expect(recorded('zz-block')?.status).toBe('cancelled');
    expect((await runPromise).status).toBe('cancelled');
  });

  it('cancelRun 打断阻塞中的 wait 节点：run 当即记 cancelled，节点记失败', async () => {
    const svc = await boot([]);
    await svc.defineWorkflow(
      { id: 'zz-wait', trigger: { type: 'manual' }, nodes: [{ id: 'a', type: 'wait', seconds: 3600 }] },
      { persist: false },
    );
    const runPromise = svc.runWorkflow('zz-wait');
    await new Promise(r => setTimeout(r, 50));

    expect(svc.cancelRun(svc.listRuns(1, 'zz-wait')[0].runId)).toBe(true);
    const run = await runPromise;
    expect(run.status).toBe('cancelled');
    expect(run.nodes[0]).toMatchObject({ status: 'failed', error: '运行已取消' });
  });
});

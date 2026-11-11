import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// workflow 依赖的服务晚于本插件上线或中途下线：
// - storage 是 required：它上线之前本插件不激活，下线时随之停下，重新上线后定义与运行历史按文件重新读回。
// - 运行历史与 once 记录同文件整份重写。init 读失败（非「文件不存在」）曾只记 warn 按空状态跑，
//   第一次运行就用 {runs:[新], onceFired:{}} 覆盖文件——下次启动所有过期 once 全部重放。
// - AI 工具经 tools 登记口挂上：提供者晚上线时登记先记下、上线后补挂；曾用 tools.current
//   判在场，tools 晚于 workflow 上线时工具永不出现。
// 真 storage-local 多根（workspace 在前、data 在后），运行历史落在 data 根。
// ════════════════════════════════════════════════════════════

const RUNS = 'workflow-runs.json';
/** 被拒的写不会有任何可等的信号：给一次本地落盘足够的时间再读 */
const settle = () => new Promise(r => setTimeout(r, 150));

describe('workflow：依赖晚于本插件上线或中途下线', () => {
  let base: string;
  let app: App;

  const registerStorage = () =>
    app.plugin(storageLocalPlugin, {
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
  const svcOf = (): WorkflowService => {
    const svc = app.bind({ services }).services.use.get(workflow);
    if (!svc) throw new Error('workflow 服务未注册');
    return svc;
  };
  // data:/ 是内部根，按数据目录布局在 state/ 下
  const runsFile = () => join(base, 'state', RUNS);

  /** 跑一次只含一个 tool 节点的手动工作流，等它执行完毕 */
  const runOnce = async () => {
    app.bind({ tools: toolsService }).tools.use.register({
      definition: {
        type: 'function',
        function: { name: 'zz_noop', description: '空操作', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => ({ content: 'ok' }),
    });
    const svc = svcOf();
    await svc.defineWorkflow(
      { id: 'zz-manual', trigger: { type: 'manual' }, nodes: [{ id: 'a', type: 'tool', tool: 'zz_noop' }] },
      { persist: false },
    );
    const run = await svc.runWorkflow('zz-manual');
    expect(run.status, '工作流没跑成，本用例没测到落盘').toBe('success');
  };

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-wf-late-'));
    mkdirSync(join(base, 'state'), { recursive: true });
    mkdirSync(join(base, 'workspace'), { recursive: true });
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('storage 晚于本插件上线：定义与运行历史照常读回，新的运行追加进去、once 记录保留', async () => {
    mkdirSync(join(base, 'workspace', 'workflows'));
    writeFileSync(
      join(base, 'workspace', 'workflows', 'zz-saved.yaml'),
      'id: zz-saved\ntrigger:\n  type: manual\nnodes:\n  - id: a\n    type: wait\n    seconds: 0\n',
    );
    const old = {
      runId: 'zz-old-run',
      workflowId: 'zz-old',
      status: 'success',
      triggerSource: 'manual',
      startedAt: 1,
      vars: {},
      nodes: [],
    };
    writeFileSync(runsFile(), JSON.stringify({ runs: [old], onceFired: { 'zz-saved': 1 } }));

    await app.plugin(toolsPlugin, {});
    await app.plugin(cronEnginePlugin, {});
    await app.plugin(workflowPlugin, { enableTools: false });
    await app.plugins.idle();
    await registerStorage();
    await app.plugins.idle();
    expect(svcOf().getWorkflow('zz-saved'), '定义目录里的定义没有载入').toBeDefined();

    await runOnce();
    await expect
      .poll(() => {
        const saved = JSON.parse(readFileSync(runsFile(), 'utf-8')) as {
          runs: Array<{ workflowId: string }>;
          onceFired: Record<string, number>;
        };
        return { runs: saved.runs.map(run => run.workflowId), onceFired: saved.onceFired };
      })
      .toEqual({ runs: ['zz-old', 'zz-manual'], onceFired: { 'zz-saved': 1 } });
  });

  it('运行历史文件损坏（解析失败）：跑工作流不覆盖原文件', async () => {
    const broken = '{"runs":[],"onceFired":{"zz-once":1}';
    writeFileSync(runsFile(), broken);

    await registerStorage();
    await app.plugin(toolsPlugin, {});
    await app.plugin(cronEnginePlugin, {});
    await app.plugin(workflowPlugin, { enableTools: false });
    await app.plugins.idle();

    await runOnce();
    await settle();

    expect(readFileSync(runsFile(), 'utf-8')).toBe(broken);
  });

  it('storage 下线：本插件随之停下；重新上线后重新激活，存下的定义照常载入', async () => {
    await registerStorage();
    await app.plugin(cronEnginePlugin, {});
    await app.plugin(workflowPlugin, { enableTools: false });
    await app.plugins.idle();
    await svcOf().defineWorkflow(
      { id: 'zz-kept', trigger: { type: 'manual' }, nodes: [{ id: 'a', type: 'wait', seconds: 0 }] },
      { persist: true },
    );

    await app.plugins.disable('@aalis/plugin-storage-local');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('@aalis/plugin-workflow')?.state).toBe('pending');
    await app.plugins.enable('@aalis/plugin-storage-local');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('@aalis/plugin-workflow')?.state).toBe('active');
    expect(svcOf().getWorkflow('zz-kept')).toBeDefined();
  });

  it('tools 晚于 workflow 上线：AI 工具随后出现', async () => {
    await registerStorage();
    await app.plugin(cronEnginePlugin, {});
    await app.plugin(workflowPlugin, {});
    await app.plugins.idle();
    expect(app.plugins.getPlugin('@aalis/plugin-workflow')?.state).toBe('active');

    await app.plugin(toolsPlugin, {});
    await app.plugins.idle();

    const names = app
      .bind({ tools: toolsService })
      .tools.use.getAll()
      .map(t => t.name);
    expect(names).toContain('workflow_define');
    expect(names).toContain('workflow_run');
  });
});

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
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// workflow 激活时依赖的 optional 服务不在场：
// - 运行历史与 once 记账同文件整份重写。init 读失败（非「文件不存在」）曾只记 warn 按空状态跑，
//   第一次运行就用 {runs:[新], onceFired:{}} 覆盖文件——下次启动所有过期 once 全部重放。
// - AI 工具经 tools 登记口挂上：提供者晚上线时登记先挂账、上线后补挂；曾用 tools.current
//   判在场，tools 晚于 workflow 上线时工具永不出现。
// 真 storage-local 多根（workspace 在前、data 在后），运行历史落在 data 根。
// ════════════════════════════════════════════════════════════

const RUNS = 'workflow-runs.json';
/** 被拒的写不会有任何可等的信号：给一次本地落盘足够的时间再读 */
const settle = () => new Promise(r => setTimeout(r, 150));

describe('workflow：optional 依赖晚于本插件上线', () => {
  let base: string;
  let app: App;

  const registerStorage = () =>
    app.plugin(storageLocalPlugin, {
      roots: ['workspace', 'data'].map(name => ({
        name,
        path: join(base, name),
        label: name,
        kind: name,
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      })),
    });
  const svcOf = (): WorkflowService => {
    const svc = app.bind({ services }).services.get(workflow);
    if (!svc) throw new Error('workflow 服务未注册');
    return svc;
  };
  const runsFile = () => join(base, 'data', RUNS);

  /** 跑一次只含一个 tool 节点的手动工作流，等它跑完 */
  const runOnce = async () => {
    app.bind({ tools: toolsService }).tools.register({
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
    mkdirSync(join(base, 'data'), { recursive: true });
    mkdirSync(join(base, 'workspace'), { recursive: true });
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('激活时 storage 不在场：随后上线再跑工作流，运行历史文件（含 once 记账）一字不动', async () => {
    const seeded = JSON.stringify({ runs: [], onceFired: { 'zz-once': 1 } }, null, 2);
    writeFileSync(runsFile(), seeded);

    await app.plugin(toolsPlugin, {});
    await app.plugin(cronEnginePlugin, {});
    await app.plugin(workflowPlugin, { enableTools: false });
    await app.plugins.idle();
    await registerStorage();
    await app.plugins.idle();

    await runOnce();
    await settle();

    expect(readFileSync(runsFile(), 'utf-8'), 'init 读失败后整份重写，once 记账被冲掉').toBe(seeded);
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
      .tools.require()
      .getAll()
      .map(t => t.name);
    expect(names).toContain('workflow_define');
    expect(names).toContain('workflow_run');
  });
});

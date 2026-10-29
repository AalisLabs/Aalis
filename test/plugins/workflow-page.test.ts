import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type WorkflowRun, type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { resolveText, type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 工作流页：新建或覆盖是带输入的动作（粘贴完整 YAML），「查看 YAML」是定义表格的详情，启用与停用按行状态显示。定义表列出
// 定义者，没有定义者的（如手写进定义目录的）写「匿名」。运行表里在跑的运行能「取消运行」（要确认），取消之后照常收尾、留在表里；
// 在跑的不在最近 50 次里也列出，运行历史按上限裁剪时也不裁，运行已经记下终态之后点取消回已经结束。进程没有正常退出时留下的
// 「运行中」载入时收口成已取消。概况的 24 小时失败只数失败的。
// 运行、定义与删除都推 invalidate；删除不存在的、运行失败的回错误。真 storage-local + 真 tools + webui-server 的真实登记表。
// ════════════════════════════════════════════════════════════

const MANUAL_YAML = `id: zz-manual
name: 手动计数
description: 每次运行计一次
trigger:
  type: manual
nodes:
  - id: a
    type: tool
    tool: zz_count
`;

/** 停在一小时的等待里：运行一直在跑，直到被取消 */
const SLOW_YAML = `id: zz-slow
name: 慢的
trigger:
  type: manual
nodes:
  - id: w
    type: wait
    seconds: 3600
`;

let base: string;
let app: App;
let pages: PageHost;
let calls: number;

/** 启动之前写进运行历史文件的几条运行 */
function storedRuns(...runs: WorkflowRun[]): void {
  mkdirSync(join(base, 'state'), { recursive: true });
  writeFileSync(join(base, 'state', 'workflow-runs.json'), JSON.stringify({ runs }));
}

/** 落盘的一次 zz-manual：一分钟前开始，结束了的一秒后结束 */
const storedRun = (runId: string, status: WorkflowRun['status']): WorkflowRun => {
  const startedAt = Date.now() - 60_000;
  return {
    runId,
    workflowId: 'zz-manual',
    status,
    triggerSource: 'manual',
    startedAt,
    ...(status === 'running' ? {} : { finishedAt: startedAt + 1000 }),
    vars: {},
    nodes: [],
  };
};

async function boot(config: Record<string, unknown> = {}): Promise<WorkflowService> {
  app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  pages = pageHost();
  app.bind({ provide }).provide.use(webuiServer, pages.service);
  provideHostPaths(app, base);
  await app.plugin(storageLocalPlugin, {
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
  app.bind({ tools: toolsService }).tools.use.register({
    definition: {
      type: 'function',
      function: { name: 'zz_count', description: '计数', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => {
      calls++;
      return { content: 'ok' };
    },
  });
  await app.plugin(workflowPlugin, config);
  await app.plugins.idle();
  return app.bind({ services }).services.use.get(workflow) as WorkflowService;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aalis-wf-page-'));
  mkdirSync(join(base, 'workspace', 'workflows'), { recursive: true });
  writeFileSync(join(base, 'workspace', 'workflows', 'zz-manual.yaml'), MANUAL_YAML);
  calls = 0;
});

afterEach(async () => {
  await app.stop();
  pages.dispose();
  rmSync(base, { recursive: true, force: true });
});

const invalidated = (since: number) => pages.invalidations.slice(since);
const WHOLE_PAGE = { instance: '@aalis/plugin-workflow', pageKey: 'workflows' };

describe('工作流页', () => {
  it('过登记门槛；概况、定义表与运行表，选中一行在详情里看 YAML', async () => {
    await boot();
    expect(pages.logs).toEqual([]);
    expect(toSource(pages.view('workflows'))).toMatchObject({ title: '工作流', placement: 'plugin', icon: 'workflow' });
    expect(toSource(pages.view('workflows').content)).toContainEqual(
      expect.objectContaining({
        id: 'workflows',
        columns: expect.arrayContaining([{ key: 'definedBy', label: '定义者' }]),
      }),
    );
    expect(toSource(await pages.data('workflows', 'summary'))).toEqual([
      { label: '定义', value: 1 },
      { label: '启用', value: 1 },
      { label: '24 小时运行', value: 0 },
      { label: '24 小时失败', value: 0 },
    ]);
    expect(toSource(await pages.data('workflows', 'workflows'))).toEqual([
      {
        id: 'zz-manual',
        name: '手动计数',
        trigger: '手动',
        nodes: 1,
        status: { text: '启用' },
        enabled: true,
        disabled: false,
        description: '每次运行计一次',
        definedBy: '匿名',
      },
    ]);
    const yaml = await pages.data<string>('workflows', 'yaml', { rowKey: 'zz-manual' });
    expect(yaml).toMatch(/^```yaml\n/);
    expect(yaml).toContain('id: zz-manual');
    await expect(pages.data('workflows', 'yaml', { rowKey: 'zz-none' })).rejects.toThrow('500');
  });

  it('立即运行：成功回一句，开始与结束各推一次 invalidate，运行表里有这一次；没有成功的回错误', async () => {
    await boot();
    const before = pages.invalidations.length;
    const reply = await pages.act('workflows', 'runWorkflow', { rowKey: 'zz-manual' });
    expect(reply.status).toBe(200);
    expect(toSource((reply.body as { message: string }).message)).toMatch(/^已运行 zz-manual，用时 /);
    expect(calls).toBe(1);
    expect(invalidated(before), '运行中与运行完都要让运行表重取').toEqual([WHOLE_PAGE, WHOLE_PAGE]);
    const runs = await pages.data<Array<Record<string, unknown>>>('workflows', 'runs');
    expect(toSource(runs)).toMatchObject([
      { workflowId: 'zz-manual', status: { text: '成功' }, triggerSource: 'manual:webui' },
    ]);

    // 工具服务不在：tool 节点失败，这一次运行以失败收尾
    await app.plugins.unload(toolsPlugin.name);
    expect(toSource(await pages.act('workflows', 'runWorkflow', { rowKey: 'zz-manual' }))).toEqual({
      status: 500,
      body: { error: '运行没有成功（失败）：节点 "a" 失败: \'tools\' 服务不可用' },
    });
  });

  it('停用与启用：按行状态切换，回一句并推 invalidate', async () => {
    const svc = await boot();
    const before = pages.invalidations.length;
    expect(await pages.act('workflows', 'disableWorkflow', { rowKey: 'zz-manual' })).toEqual({
      status: 200,
      body: { message: expect.objectContaining({ source: '已停用 zz-manual' }) },
    });
    expect(svc.getWorkflow('zz-manual')?.enabled).toBe(false);
    expect(toSource(await pages.data('workflows', 'workflows'))).toMatchObject([
      { status: { text: '停用', state: 'inactive' }, enabled: false, disabled: true },
    ]);
    expect(await pages.act('workflows', 'enableWorkflow', { rowKey: 'zz-manual' })).toEqual({
      status: 200,
      body: { message: expect.objectContaining({ source: '已启用 zz-manual' }) },
    });
    expect(invalidated(before)).toContainEqual(WHOLE_PAGE);
  });

  it('新建或覆盖：粘贴 YAML 定义并写入磁盘；YAML 解析不了或定义不完整回错误原因', async () => {
    const svc = await boot();
    const before = pages.invalidations.length;
    const yaml = MANUAL_YAML.replace('zz-manual', 'zz-second');
    expect(await pages.act('workflows', 'defineWorkflow', { input: { yaml } })).toEqual({
      status: 200,
      body: { message: expect.objectContaining({ source: '已保存工作流 zz-second' }) },
    });
    expect(svc.getWorkflow('zz-second')).toBeDefined();
    expect(toSource(await pages.data('workflows', 'workflows'))).toContainEqual(
      expect.objectContaining({ id: 'zz-second', definedBy: 'webui:console' }),
    );
    expect(existsSync(join(base, 'workspace', 'workflows', 'zz-second.yaml'))).toBe(true);
    expect(invalidated(before)).toContainEqual(WHOLE_PAGE);

    const broken = await pages.act('workflows', 'defineWorkflow', { input: { yaml: 'id: [' } });
    expect(broken.status).toBe(500);
    expect(toSource((broken.body as { error: string }).error)).toMatch(/^YAML 解析失败/);
    expect(toSource(await pages.act('workflows', 'defineWorkflow', { input: { yaml: 'id: x' } }))).toEqual({
      status: 500,
      body: { error: '定义不合法：缺少 trigger 或 nodes' },
    });
  });

  it('删除：定义与文件都不在了并推 invalidate；不存在的回错误，不当成功', async () => {
    const svc = await boot();
    const before = pages.invalidations.length;
    expect(toSource(await pages.act('workflows', 'removeWorkflow', { rowKey: 'zz-manual' }))).toEqual({
      status: 200,
      body: { message: '已删除 zz-manual' },
    });
    expect(svc.getWorkflow('zz-manual')).toBeUndefined();
    expect(existsSync(join(base, 'workspace', 'workflows', 'zz-manual.yaml'))).toBe(false);
    expect(invalidated(before)).toContainEqual(WHOLE_PAGE);
    expect(toSource(await pages.act('workflows', 'removeWorkflow', { rowKey: 'zz-manual' }))).toEqual({
      status: 500,
      body: { error: '工作流 zz-manual 不存在' },
    });
  });

  it('取消运行：在跑的运行行上有「取消运行」（要确认），点了之后照常收尾，记录留在运行表里、状态为已取消；结束之后再点回一句已经结束', async () => {
    writeFileSync(join(base, 'workspace', 'workflows', 'zz-slow.yaml'), SLOW_YAML);
    const svc = await boot();
    const { content, actions } = pages.view('workflows');
    expect(toSource(content)).toContainEqual(
      expect.objectContaining({ id: 'runs', rowActions: [{ action: 'cancelRun', visibleWhen: 'running' }] }),
    );
    // 动作名写明取消什么：确认框里关掉框的按钮写「取消」，确认的按钮写动作名，两个不同名
    expect(toSource(actions?.cancelRun)).toMatchObject({
      label: '取消运行',
      effect: 'destructive',
      confirm: expect.stringContaining('记录留在运行历史里'),
    });
    expect(resolveText(actions?.cancelRun.label as TextRef, ['en'])).toBe('Cancel run');
    const slow = svc.runWorkflow('zz-slow', {}, 'manual');
    const [{ runId }] = svc.listRuns(1, 'zz-slow');
    /** 运行表里这次运行的那一行 */
    const row = async () =>
      toSource(await pages.data<Array<Record<string, unknown>>>('workflows', 'runs')).find(r => r.runId === runId);
    expect(await row()).toMatchObject({ status: { text: '运行中' }, running: true });
    expect((await row())?.duration, '在跑的用时算到现在').not.toBe('—');

    const before = pages.invalidations.length;
    expect(toSource(await pages.act('workflows', 'cancelRun', { rowKey: runId }))).toEqual({
      status: 200,
      body: { message: `已取消 ${runId}` },
    });
    expect((await slow).status).toBe('cancelled');
    expect(invalidated(before), '收尾时让运行表重取').toContainEqual(WHOLE_PAGE);
    expect(await row()).toMatchObject({ status: { text: '已取消' }, running: false });
    expect(toSource(await pages.act('workflows', 'cancelRun', { rowKey: runId }))).toEqual({
      status: 500,
      body: { error: '这次运行已经结束' },
    });
  });

  it('在跑的运行被之后的 50 次挤出最近 50 次时照样列在运行表里，排在最后、带取消', async () => {
    writeFileSync(join(base, 'workspace', 'workflows', 'zz-slow.yaml'), SLOW_YAML);
    const svc = await boot();
    const slow = svc.runWorkflow('zz-slow', {}, 'manual');
    const [{ runId }] = svc.listRuns(1, 'zz-slow');
    // 之后的 50 次都比它晚开始
    await new Promise(resolve => setTimeout(resolve, 5));
    for (let i = 0; i < 50; i++) await svc.runWorkflow('zz-manual', {}, 'manual');
    const rows = toSource(await pages.data<Array<Record<string, unknown>>>('workflows', 'runs'));
    expect(rows).toHaveLength(51);
    expect(rows.at(-1)).toMatchObject({ runId, running: true });
    svc.cancelRun(runId);
    expect((await slow).status).toBe('cancelled');
  });

  it('运行历史按上限裁剪时不裁在跑的：上限之内有一次在跑，再跑满上限次，它仍在历史里，收尾时照常更新', async () => {
    writeFileSync(join(base, 'workspace', 'workflows', 'zz-slow.yaml'), SLOW_YAML);
    const svc = await boot({ maxRuns: 10 });
    const slow = svc.runWorkflow('zz-slow', {}, 'manual');
    const [{ runId }] = svc.listRuns(1, 'zz-slow');
    for (let i = 0; i < 10; i++) await svc.runWorkflow('zz-manual', {}, 'manual');
    expect(svc.listRuns().map(r => r.runId)).toContain(runId);
    expect(svc.listRuns(), '裁掉的是最旧的已结束的那一次').toHaveLength(10);
    svc.cancelRun(runId);
    expect((await slow).status).toBe('cancelled');
    expect(svc.getRun(runId)).toMatchObject({ status: 'cancelled' });
    expect(svc.listRuns()).toHaveLength(10);
  });

  it('进程没有正常退出时留下的「运行中」：载入时收口成已取消，错误写进程退出时中断、没有用时，行上不带取消运行；节点与引擎取消时同样收：在跑的记失败、等着的记跳过', async () => {
    const startedAt = Date.now() - 60_000;
    storedRuns({
      ...storedRun('zz-crashed', 'running'),
      nodes: [
        { id: 'zz-done', type: 'tool', status: 'success', startedAt, finishedAt: startedAt + 1000 },
        { id: 'zz-busy', type: 'tool', status: 'running', startedAt: startedAt + 1000 },
        { id: 'zz-next', type: 'tool', status: 'pending' },
      ],
    });
    const svc = await boot();
    expect(svc.getRun('zz-crashed')).toMatchObject({ status: 'cancelled' });
    expect(resolveText(svc.getRun('zz-crashed')?.error as TextRef, ['en'])).toBe('Interrupted when the process exited');
    const nodes = svc.getRun('zz-crashed')?.nodes ?? [];
    expect(nodes.map(({ id, status }) => [id, status])).toEqual([
      ['zz-done', 'success'],
      ['zz-busy', 'failed'],
      ['zz-next', 'skipped'],
    ]);
    expect(toSource(nodes[1].error)).toBe('进程退出时中断');
    expect(toSource(await pages.data('workflows', 'runs'))).toEqual([
      expect.objectContaining({
        runId: 'zz-crashed',
        status: { text: '已取消', state: 'inactive' },
        error: '进程退出时中断',
        duration: '—',
        running: false,
      }),
    ]);
    // 交给模型的运行历史同样不写用时
    const result = await app
      .bind({ tools: toolsService })
      .tools.use.execute('workflow_get_runs', {}, toolRequest({ sessionId: 'internal', platform: 'internal' }));
    const [run] = (JSON.parse(result.content) as { runs: Array<Record<string, unknown>> }).runs;
    expect(run).toMatchObject({ runId: 'zz-crashed', status: 'cancelled', error: '进程退出时中断' });
    expect(run).not.toHaveProperty('durationMs');
  });

  it('概况的「24 小时失败」只数失败的，不算已取消的', async () => {
    storedRuns(storedRun('zz-failed', 'failed'), storedRun('zz-cancelled', 'cancelled'));
    await boot();
    expect(toSource(await pages.data('workflows', 'summary'))).toEqual(
      expect.arrayContaining([
        { label: '24 小时运行', value: 2 },
        { label: '24 小时失败', value: 1 },
      ]),
    );
  });

  it('运行已经记下终态、收尾的监听还没跑完时点取消：回这次运行已经结束，运行照旧成功', async () => {
    const svc = await boot();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const entered = new Promise<void>(resolve => {
      app.bind({ events }).events.use.on('workflow:run:done', async () => {
        resolve();
        await held;
      });
    });
    const run = svc.runWorkflow('zz-manual', {}, 'manual');
    await entered;
    const [{ runId }] = svc.listRuns(1, 'zz-manual');
    expect(toSource(await pages.act('workflows', 'cancelRun', { rowKey: runId }))).toEqual({
      status: 500,
      body: { error: '这次运行已经结束' },
    });
    release();
    expect((await run).status).toBe('success');
  });
});

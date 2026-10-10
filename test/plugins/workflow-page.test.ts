import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 工作流页：新建或覆盖是带输入的动作（粘贴完整 YAML），「查看 YAML」是定义表格的详情，启用与停用按行状态显示。
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

let base: string;
let app: App;
let pages: PageHost;
let calls: number;

async function boot(): Promise<WorkflowService> {
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
  await app.plugin(workflowPlugin, {});
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
    expect(pages.view('workflows')).toMatchObject({ title: '工作流', placement: 'plugin', icon: 'workflow' });
    expect(await pages.data('workflows', 'summary')).toEqual([
      { label: '定义', value: 1 },
      { label: '启用', value: 1 },
      { label: '24 小时运行', value: 0 },
      { label: '24 小时失败', value: 0 },
    ]);
    expect(await pages.data('workflows', 'workflows')).toEqual([
      {
        id: 'zz-manual',
        name: '手动计数',
        trigger: '手动',
        nodes: 1,
        status: { text: '启用' },
        enabled: true,
        disabled: false,
        description: '每次运行计一次',
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
    expect((reply.body as { message: string }).message).toMatch(/^已运行 zz-manual，用时 /);
    expect(calls).toBe(1);
    expect(invalidated(before), '运行中与运行完都要让运行表重取').toEqual([WHOLE_PAGE, WHOLE_PAGE]);
    const runs = await pages.data<Array<Record<string, unknown>>>('workflows', 'runs');
    expect(runs).toMatchObject([{ workflowId: 'zz-manual', status: { text: '成功' }, triggerSource: 'manual:webui' }]);

    // 工具服务不在：tool 节点失败，这一次运行以失败收尾
    await app.plugins.unload(toolsPlugin.name);
    expect(await pages.act('workflows', 'runWorkflow', { rowKey: 'zz-manual' })).toEqual({
      status: 500,
      body: { error: '运行没有成功（失败）：节点 "a" 失败: \'tools\' 服务不可用' },
    });
  });

  it('停用与启用：按行状态切换，回一句并推 invalidate', async () => {
    const svc = await boot();
    const before = pages.invalidations.length;
    expect(await pages.act('workflows', 'disableWorkflow', { rowKey: 'zz-manual' })).toEqual({
      status: 200,
      body: { message: '已停用 zz-manual' },
    });
    expect(svc.getWorkflow('zz-manual')?.enabled).toBe(false);
    expect(await pages.data('workflows', 'workflows')).toMatchObject([
      { status: { text: '停用', state: 'inactive' }, enabled: false, disabled: true },
    ]);
    expect(await pages.act('workflows', 'enableWorkflow', { rowKey: 'zz-manual' })).toEqual({
      status: 200,
      body: { message: '已启用 zz-manual' },
    });
    expect(invalidated(before)).toContainEqual(WHOLE_PAGE);
  });

  it('新建或覆盖：粘贴 YAML 定义并写入磁盘；YAML 解析不了或定义不完整回错误原因', async () => {
    const svc = await boot();
    const before = pages.invalidations.length;
    const yaml = MANUAL_YAML.replace('zz-manual', 'zz-second');
    expect(await pages.act('workflows', 'defineWorkflow', { input: { yaml } })).toEqual({
      status: 200,
      body: { message: '已保存工作流 zz-second' },
    });
    expect(svc.getWorkflow('zz-second')).toBeDefined();
    expect(existsSync(join(base, 'workspace', 'workflows', 'zz-second.yaml'))).toBe(true);
    expect(invalidated(before)).toContainEqual(WHOLE_PAGE);

    const broken = await pages.act('workflows', 'defineWorkflow', { input: { yaml: 'id: [' } });
    expect(broken.status).toBe(500);
    expect((broken.body as { error: string }).error).toMatch(/^YAML 解析失败/);
    expect(await pages.act('workflows', 'defineWorkflow', { input: { yaml: 'id: x' } })).toEqual({
      status: 500,
      body: { error: '定义不合法：缺少 trigger 或 nodes' },
    });
  });

  it('删除：定义与文件都不在了并推 invalidate；不存在的回错误，不当成功', async () => {
    const svc = await boot();
    const before = pages.invalidations.length;
    expect(await pages.act('workflows', 'removeWorkflow', { rowKey: 'zz-manual' })).toEqual({
      status: 200,
      body: { message: '已删除 zz-manual' },
    });
    expect(svc.getWorkflow('zz-manual')).toBeUndefined();
    expect(existsSync(join(base, 'workspace', 'workflows', 'zz-manual.yaml'))).toBe(false);
    expect(invalidated(before)).toContainEqual(WHOLE_PAGE);
    expect(await pages.act('workflows', 'removeWorkflow', { rowKey: 'zz-manual' })).toEqual({
      status: 500,
      body: { error: '工作流 zz-manual 不存在' },
    });
  });
});

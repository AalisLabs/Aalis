import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type WorkflowDef, type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 编排定义的当场校验。
// 一、id 是定义文件的文件名（<id>.yaml），只收字母、数字、下划线与连字符：带 ../ 的 id 把写与删引到定义目录之外（workspace
//    根默认可删）。定义时不合规的报错、不保存；定义目录里不合规的不载入；删除只对已载入的定义动存储，别的 id 回 false、不碰文件。
// 二、触发器写错的当场拒收、不保存：cron 交 cron-engine 校验；interval 的 seconds 要是大于 0、不超过上限（约 24.8 天）的数，
//    超过的交给 setInterval 会溢出成每毫秒触发；once 的 runAt 要能解析。定义目录里超上限的 interval 照常载入，订阅不上、不触发。
// 真 storage-local（workspace 根指向临时目录、可删）、真 tools 与 cron-engine；工具调用经放行一切的执行守卫。
// ════════════════════════════════════════════════════════════

const yamlOf = (id: string, trigger = '  type: manual') => `id: ${JSON.stringify(id)}
trigger:
${trigger}
nodes:
  - id: w
    type: wait
    seconds: 0
`;
const NODES: WorkflowDef['nodes'] = [{ id: 'w', type: 'wait', seconds: 0 }];
const badId = (id: string) => `工作流 id 只能用字母、数字、下划线与连字符（它是定义文件的文件名）：${id}`;
const badInterval = (value: string) => `间隔须大于 0 且不超过 2,147,483 秒（约 24.8 天）：${value}`;

let base: string;
let app: App;
let pages: PageHost;

const workspaceFile = (...path: string[]) => join(base, 'workspace', ...path);
const defsDir = () => workspaceFile('workflows');

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
        path: workspaceFile(),
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
  await app.plugin(workflowPlugin, {});
  await app.plugins.idle();
  app.bind({ tools: toolsService }).tools.use.setExecutionGuard(async () => ({ ok: true }));
  return app.bind({ services }).services.use.get(workflow) as WorkflowService;
}

/** 调一个工具，结果按 JSON 读 */
async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await app
    .bind({ tools: toolsService })
    .tools.use.execute(name, args, toolRequest({ sessionId: 'internal', platform: 'webui', userId: 'console' }));
  return JSON.parse(result.content);
}

const defineOnPage = async (yaml: string) =>
  toSource(await pages.act('workflows', 'defineWorkflow', { input: { yaml, persist: true } }));

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aalis-wf-checks-'));
  mkdirSync(defsDir(), { recursive: true });
  writeFileSync(workspaceFile('notes.yaml'), 'keep: true\n');
});

afterEach(async () => {
  vi.useRealTimers();
  await app.stop();
  pages.dispose();
  rmSync(base, { recursive: true, force: true });
});

describe('编排 id 只收字母、数字、下划线与连字符', () => {
  it('不合规的 id：workflow_define、工作流页与服务的 defineWorkflow 都报错，不写文件', async () => {
    const svc = await boot();
    expect(await tool('workflow_define', { yaml: yamlOf('../notes') })).toEqual({ error: badId('../notes') });
    expect(await defineOnPage(yamlOf('a/b'))).toEqual({ status: 500, body: { error: badId('a/b') } });
    await expect(
      svc.defineWorkflow({ id: 'x/../../notes', trigger: { type: 'manual' }, nodes: NODES }),
    ).rejects.toThrow(badId('x/../../notes'));
    expect(readFileSync(workspaceFile('notes.yaml'), 'utf-8')).toBe('keep: true\n');
    expect(readdirSync(defsDir())).toEqual([]);
    expect(svc.listWorkflows()).toEqual([]);

    expect(await tool('workflow_define', { yaml: yamlOf('zz-ok_1') })).toMatchObject({ ok: true, id: 'zz-ok_1' });
    expect(readdirSync(defsDir())).toEqual(['zz-ok_1.yaml']);
  });

  it('中文等各种文字的字母照收：定义目录里的照常载入，新定义照常写文件', async () => {
    writeFileSync(join(defsDir(), '每日汇总.yaml'), yamlOf('每日汇总'));
    const svc = await boot();
    expect(svc.listWorkflows().map(def => def.id)).toEqual(['每日汇总']);
    expect(await tool('workflow_define', { yaml: yamlOf('周报_2') })).toMatchObject({ ok: true, id: '周报_2' });
    expect(readdirSync(defsDir()).sort()).toEqual(['周报_2.yaml', '每日汇总.yaml'].sort());
  });

  it('删除只对已载入的定义动存储：借 ../ 删不到定义目录之外，载入失败的定义文件也不删，都回不存在', async () => {
    mkdirSync(workspaceFile('project'));
    writeFileSync(workspaceFile('project', 'docker-compose.yaml'), 'services: {}\n');
    // 依赖未知节点：校验不过，不载入
    writeFileSync(
      join(defsDir(), 'zz-broken.yaml'),
      'id: zz-broken\ntrigger:\n  type: manual\nnodes:\n  - id: a\n    type: wait\n    seconds: 0\n    deps: [nope]\n',
    );
    const svc = await boot();
    expect(await tool('workflow_remove', { id: '../notes' })).toEqual({ ok: false, message: '不存在' });
    expect(await svc.removeWorkflow('../project/docker-compose')).toBe(false);
    expect(await svc.removeWorkflow('zz-broken')).toBe(false);
    expect(existsSync(workspaceFile('notes.yaml'))).toBe(true);
    expect(existsSync(workspaceFile('project', 'docker-compose.yaml'))).toBe(true);
    expect(existsSync(join(defsDir(), 'zz-broken.yaml'))).toBe(true);
  });

  it('定义目录里 id 不合规的定义不载入，删不到它指向的文件', async () => {
    writeFileSync(join(defsDir(), 'zz-evil.yaml'), yamlOf('../notes'));
    const svc = await boot();
    expect(svc.listWorkflows()).toEqual([]);
    expect(await svc.removeWorkflow('../notes')).toBe(false);
    expect(existsSync(workspaceFile('notes.yaml'))).toBe(true);
  });
});

describe('写错的触发器当场拒收', () => {
  it('cron、interval、once 写错：workflow_define、工作流页与服务的 defineWorkflow 都报原因，不保存；写对的照收', async () => {
    const svc = await boot();
    const bad: Array<[string, string, string]> = [
      ['cron 字段越界', '  type: cron\n  expr: "61 * * * *"', 'cron 第 1 字段非法（解析为空）: "61"'],
      ['cron 没写表达式', '  type: cron', '表达式为空'],
      ['interval 写成字符串', '  type: interval\n  seconds: abc', badInterval('abc')],
      ['interval 是负数', '  type: interval\n  seconds: -5', badInterval('-5')],
      ['interval 超过上限', '  type: interval\n  seconds: 2592000', badInterval('2592000')],
      ['once 解析不了', '  type: once\n  runAt: 明天', 'once 触发器的 runAt 不是能解析的时间：明天'],
    ];
    for (const [label, trigger, error] of bad) {
      expect(await tool('workflow_define', { yaml: yamlOf('zz-bad', trigger) }), label).toEqual({ error });
    }
    expect(await defineOnPage(yamlOf('zz-bad', '  type: interval\n  seconds: 2592000'))).toEqual({
      status: 500,
      body: { error: badInterval('2592000') },
    });
    await expect(
      svc.defineWorkflow({ id: 'zz-bad', trigger: { type: 'interval', seconds: 2592000 }, nodes: NODES }),
    ).rejects.toThrow(badInterval('2592000'));
    expect(svc.listWorkflows()).toEqual([]);
    expect(readdirSync(defsDir())).toEqual([]);

    const runAt = new Date(Date.now() + 86_400_000).toISOString();
    const good = [
      '  type: cron\n  expr: "0 9 * * *"',
      '  type: interval\n  seconds: 2147483',
      `  type: once\n  runAt: "${runAt}"`,
    ];
    for (const [i, trigger] of good.entries()) {
      expect(await tool('workflow_define', { yaml: yamlOf(`zz-good-${i}`, trigger) }), trigger).toMatchObject({
        ok: true,
      });
    }
  });

  // 假时钟同 Node：setInterval 的延时超过 2^31-1 毫秒按 1 毫秒处理；只假 setInterval（interval 触发器经 cron-engine 的 @every 用它）
  it('定义目录里超过上限的 interval：照常载入，触发器订阅不上、不触发', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    writeFileSync(join(defsDir(), 'zz-month.yaml'), yamlOf('zz-month', '  type: interval\n  seconds: 2592000'));
    const svc = await boot();
    const started: string[] = [];
    app.bind({ events }).events.use.on('workflow:run:start', run => {
      started.push(run.workflowId);
    });
    expect(svc.listWorkflows().map(d => d.id)).toEqual(['zz-month']);
    await vi.advanceTimersByTimeAsync(50);
    expect(started, '溢出的话 50 毫秒里会起 50 次运行').toEqual([]);
  });
});

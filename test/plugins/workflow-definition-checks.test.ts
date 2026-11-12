import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type WorkflowDef, type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
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
// 一、新定义的 id 是新定义文件的文件名（<id>.yaml），只收各种文字的字母（含组合符号）、数字、下划线与连字符，不收看不见的
//    韩文填充字母：带 ../ 的 id 把写与删引到定义目录之外（workspace 根默认可删）。新定义不合规的报错、不保存；要写的 <id>.yaml
//    已经存在、存的是另一个 id 的定义（另一条定义的文件，或不分大小写与字形的卷上另一个 id 的文件）的同样拒收。定义目录里的定义
//    按文件载入，只拒空 id 与带 / \ NUL 的；改写与删除对的都是载入时的文件，不按 id 拼路径；删除只对已载入的定义动存储，
//    别的 id 回 false、不碰文件。
// 二、启用的定义触发器写错的当场拒收、不保存：cron 交 cron-engine 校验；interval 的 seconds 要是大于 0、不超过上限（约 24.8 天）
//    的数，超过的交给 setInterval 会溢出成每毫秒触发；once 的 runAt 要能解析。停用的不注册触发器，不校验它，启用时再校验。
//    定义目录里超上限的 interval 照常载入，订阅不上、不触发。
// 三、wait 节点的 seconds 与 agent 节点的 timeoutSeconds 同样交给定时器，不超过同一个上限，超过的报错、不保存。
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
const fileTaken = (file: string, other: string, id: string) =>
  `定义文件 ${file} 已被工作流 ${other} 占用，请给工作流 ${id} 换一个 id（文件系统不分大小写或字形时，看着不同的 id 也会落到同一个文件）`;
/** 临时目录所在的卷不分大小写（macOS 默认的 APFS）：不同的 id 会落到同一个定义文件 */
const caseInsensitive = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-wf-case-'));
  try {
    writeFileSync(join(dir, 'a'), '');
    return existsSync(join(dir, 'A'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
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

  it('新定义：各种文字要用的组合符号照收；空格、点等仍不收，看不见的韩文填充字母不收', async () => {
    const svc = await boot();
    for (const id of ['สรุป', 'café'.normalize('NFD'), 'データ'.normalize('NFD')]) {
      expect(await tool('workflow_define', { yaml: yamlOf(id) }), id).toMatchObject({ ok: true, id });
    }
    for (const id of ['每日 汇总.v2', '\u3164', 'a\u115Fb', 'x\u1160', '\uFFA0周报']) {
      expect(await tool('workflow_define', { yaml: yamlOf(id) }), JSON.stringify(id)).toEqual({ error: badId(id) });
    }
    expect(svc.listWorkflows()).toHaveLength(3);
    expect(readdirSync(defsDir())).toHaveLength(3);
  });

  it('定义目录里新定义收不下的 id（空格、点、全角括号、间隔号、泰文、NFD）照常载入，能停用、能删，对的是载入时的文件', async () => {
    const ids = ['每日 汇总.v2', '日报（周一）', '周报·新', 'สรุป', 'データ'.normalize('NFD')];
    for (const id of ids) writeFileSync(join(defsDir(), `${id}.yaml`), yamlOf(id));
    const svc = await boot();
    expect(
      svc
        .listWorkflows()
        .map(def => def.id)
        .sort(),
    ).toEqual([...ids].sort());
    for (const id of ids) {
      expect(toSource(await pages.act('workflows', 'disableWorkflow', { rowKey: id })), id).toEqual({
        status: 200,
        body: { message: `已停用 ${id}` },
      });
      expect(readFileSync(join(defsDir(), `${id}.yaml`), 'utf-8'), id).toContain('enabled: false');
      expect(await svc.removeWorkflow(id), id).toBe(true);
    }
    expect(readdirSync(defsDir())).toEqual([]);
  });

  it('文件名与 id 不同、.yml 的定义：改写与删除对载入时的文件，不碰恰好叫 <id>.yaml 的另一条', async () => {
    writeFileSync(join(defsDir(), 'x.yml'), yamlOf('x'));
    writeFileSync(join(defsDir(), 'a.yaml'), yamlOf('b'));
    writeFileSync(join(defsDir(), 'b.yaml'), yamlOf('c'));
    const svc = await boot();
    expect(
      svc
        .listWorkflows()
        .map(def => def.id)
        .sort(),
    ).toEqual(['b', 'c', 'x']);

    expect(toSource(await pages.act('workflows', 'disableWorkflow', { rowKey: 'b' }))).toMatchObject({ status: 200 });
    expect(readFileSync(join(defsDir(), 'a.yaml'), 'utf-8')).toContain('enabled: false');
    expect(readFileSync(join(defsDir(), 'b.yaml'), 'utf-8')).toBe(yamlOf('c'));

    expect(await svc.removeWorkflow('x')).toBe(true);
    expect(await svc.removeWorkflow('b')).toBe(true);
    expect(readdirSync(defsDir())).toEqual(['b.yaml']);
    expect(readFileSync(join(defsDir(), 'b.yaml'), 'utf-8')).toBe(yamlOf('c'));
    expect(svc.listWorkflows().map(def => def.id)).toEqual(['c']);
  });

  it('新定义要写的 <id>.yaml 存着另一个 id 的定义：拒收，写明被哪一条占用，文件不动', async () => {
    writeFileSync(join(defsDir(), 'a.yaml'), yamlOf('b'));
    const svc = await boot();
    expect(await tool('workflow_define', { yaml: yamlOf('a') })).toEqual({ error: fileTaken('a.yaml', 'b', 'a') });
    expect(readFileSync(join(defsDir(), 'a.yaml'), 'utf-8')).toBe(yamlOf('b'));
    expect(svc.listWorkflows().map(def => def.id)).toEqual(['b']);
  });

  it('定义目录里载入不了的同 id 定义：新定义照常覆盖它（存的就是这个 id）', async () => {
    writeFileSync(
      join(defsDir(), 'zz-broken.yaml'),
      'id: zz-broken\ntrigger:\n  type: manual\nnodes:\n  - id: a\n    type: wait\n    seconds: 0\n    deps: [nope]\n',
    );
    const svc = await boot();
    expect(svc.listWorkflows()).toEqual([]);
    expect(await tool('workflow_define', { yaml: yamlOf('zz-broken') })).toMatchObject({ ok: true });
    expect(readFileSync(join(defsDir(), 'zz-broken.yaml'), 'utf-8')).not.toContain('nope');
  });

  // 只在不分大小写与字形的卷上成立（macOS 默认的 APFS）：分大小写的卷上这几对本来就是不同的文件
  it.runIf(caseInsensitive)('不分大小写与字形的卷上，落到同一个文件的两个 id：后来的拒收，先来的文件不动', async () => {
    const svc = await boot();
    for (const [first, second] of [
      ['daily', 'Daily'],
      ['K', '\u212A'],
      ['データ', 'データ'.normalize('NFD')],
    ]) {
      expect(await tool('workflow_define', { yaml: yamlOf(first) }), first).toMatchObject({ ok: true });
      expect(await tool('workflow_define', { yaml: yamlOf(second) }), second).toEqual({
        error: fileTaken(`${second}.yaml`, first, second),
      });
      expect(readFileSync(join(defsDir(), `${first}.yaml`), 'utf-8'), first).toContain(`id: ${first}\n`);
      expect(await svc.removeWorkflow(first), first).toBe(true);
    }
    expect(svc.listWorkflows()).toEqual([]);
    expect(readdirSync(defsDir())).toEqual([]);
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
      ['cron 字段越界', '  type: cron\n  expr: "61 * * * *"', 'cron 第 1 字段非法（解析为空）："61"'],
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

  it('触发器写错的定义能停用：停用的不注册触发器、不校验它，启用时再报原因', async () => {
    writeFileSync(join(defsDir(), 'zz-month.yaml'), yamlOf('zz-month', '  type: interval\n  seconds: 2592000'));
    writeFileSync(join(defsDir(), 'zz-cron.yaml'), yamlOf('zz-cron', '  type: cron\n  expr: "61 * * * *"'));
    const svc = await boot();
    for (const id of ['zz-month', 'zz-cron']) {
      expect(toSource(await pages.act('workflows', 'disableWorkflow', { rowKey: id })), id).toEqual({
        status: 200,
        body: { message: `已停用 ${id}` },
      });
      expect(readFileSync(join(defsDir(), `${id}.yaml`), 'utf-8'), id).toContain('enabled: false');
    }
    expect(toSource(await pages.act('workflows', 'enableWorkflow', { rowKey: 'zz-month' }))).toEqual({
      status: 500,
      body: { error: badInterval('2592000') },
    });
    expect(svc.getWorkflow('zz-month')?.enabled).toBe(false);
    await svc.defineWorkflow({
      id: 'zz-off',
      enabled: false,
      trigger: { type: 'interval', seconds: 2592000 },
      nodes: NODES,
    });
    expect(svc.getWorkflow('zz-off')?.enabled).toBe(false);
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
    expect(started, '溢出的话 50 毫秒里会启动 50 次运行').toEqual([]);
  });
});

describe('节点的等待与时限', () => {
  // 等待与 agent 节点的时限同样交给 setTimeout：超过 2^31-1 毫秒按 1 毫秒处理，等待立刻结束、agent 节点立刻超时
  it('wait 的 seconds、agent 的 timeoutSeconds 超过上限：当场拒收、不保存；上限本身照收', async () => {
    const svc = await boot();
    const tooLong = (node: string, type: string, field: string) =>
      `节点 "${node}"(${type}) 的 ${field} 不能超过 2,147,483 秒（约 24.8 天）：2592000`;
    const withNodes = (nodes: string) => `id: zz-long\ntrigger:\n  type: manual\nnodes:\n${nodes}`;
    const wait = (seconds: number) => `  - id: w\n    type: wait\n    seconds: ${seconds}\n`;
    const agent = (timeoutSeconds: number) =>
      `  - id: a\n    type: agent\n    instruction: 汇总\n    timeoutSeconds: ${timeoutSeconds}\n`;
    expect(await tool('workflow_define', { yaml: withNodes(wait(2592000)) })).toEqual({
      error: tooLong('w', 'wait', 'seconds'),
    });
    expect(await tool('workflow_define', { yaml: withNodes(agent(2592000)) })).toEqual({
      error: tooLong('a', 'agent', 'timeoutSeconds'),
    });
    expect(svc.listWorkflows()).toEqual([]);
    expect(readdirSync(defsDir())).toEqual([]);
    expect(await tool('workflow_define', { yaml: withNodes(wait(2147483) + agent(2147483)) })).toMatchObject({
      ok: true,
    });
  });
});

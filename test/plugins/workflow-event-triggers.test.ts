import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type WorkflowDef, type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { App, type Logger, LogHub, provide, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { TriggerManager } from '../../packages/plugin-workflow/src/triggers.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { ref } from '../fixtures/service-ref.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// event 触发器不订阅不可作触发源的事件：注册时记一条 warn，不碰事件总线；别的事件照常订阅。哪些事件不可作触发源由
// test/architecture/event-trigger-sources.test.ts 守。直接驱动 TriggerManager，事件总线只记下订阅了什么。
// ════════════════════════════════════════════════════════════

function manager() {
  const subscribed: string[] = [];
  const warnings: string[] = [];
  const logger = { warn: (msg: string) => warnings.push(msg) } as unknown as Logger;
  const events = {
    on: (event: string) => {
      subscribed.push(event);
      return () => {};
    },
  };
  const triggers = new TriggerManager({ cronEngine: ref(), events: events as never, logger }, () => {}, {
    onceLedgerReadable: () => true,
    onceFiredAt: () => undefined,
    markOnceFired() {},
  });
  return { triggers, subscribed, warnings };
}

const onEvent = (event: string): WorkflowDef => ({
  id: 'zz-wf',
  trigger: { type: 'event', event },
  nodes: [{ id: 'a', type: 'tool', tool: 'zz_count' }],
});

describe('event 触发器订阅的事件', () => {
  it('不可作触发源的事件：不订阅，记 warn', () => {
    const { triggers, subscribed, warnings } = manager();
    triggers.register(onEvent('inbound:message'));
    expect(subscribed).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('别的事件照常订阅', () => {
    const { triggers, subscribed, warnings } = manager();
    triggers.register(onEvent('scheduler:job:done'));
    expect(subscribed).toEqual(['scheduler:job:done']);
    expect(warnings).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
// 定义时就拒：订阅不可作触发源的事件的定义，经 workflow_define、工作流页「新建或覆盖」与编排服务的 defineWorkflow 都报错、
// 写明哪个事件与原因，不保存；已在定义目录里的照常载入，触发器不注册、记 warn 写明怎么办，文件不动。
// 真 storage-local + 真 tools + webui-server 的真实登记表。
// ════════════════════════════════════════════════════════════

const BLOCKED_YAML = `id: zz-wf
trigger:
  type: event
  event: inbound:message
nodes:
  - id: a
    type: tool
    tool: zz_count
`;
const REFUSED = 'event 触发器订阅的 inbound:message 负载带会话内容（会话 id、平台、正文等），不能当触发源';

describe('订阅不可作触发源的事件的定义', () => {
  let base: string;
  let app: App;
  let pages: PageHost;
  let warnings: string[];
  const defFile = () => join(base, 'workspace', 'workflows', 'zz-wf.yaml');

  async function boot() {
    const logHub = new LogHub();
    logHub.onEntry(entry => {
      if (entry.level === 'warn') warnings.push(entry.message);
    });
    app = new App({ name: 'T', logLevel: 'warn', logHub });
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
    await app.plugin(workflowPlugin, {});
    await app.plugins.idle();
    const registry = app.bind({ services }).services.use;
    const toolSvc = registry.get(toolsService);
    if (!toolSvc) throw new Error('tools 服务未注册');
    toolSvc.setExecutionGuard(async () => ({ ok: true })); // workflow_define 是 sensitive，放行权限闸：这里只看定义口
    return { svc: registry.get(workflow) as WorkflowService, toolSvc };
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-wf-blocked-'));
    mkdirSync(join(base, 'workspace', 'workflows'), { recursive: true });
    warnings = [];
  });

  afterEach(async () => {
    await app?.stop();
    pages?.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  it.each([
    'workflow_define',
    '新建或覆盖',
    'defineWorkflow',
  ] as const)('经 %s 定义：报错写明哪个事件、为什么，不保存', async via => {
    const { svc, toolSvc } = await boot();
    if (via === 'workflow_define') {
      const res = await toolSvc.execute(
        'workflow_define',
        { yaml: BLOCKED_YAML },
        toolRequest({ sessionId: 'internal', platform: 'internal' }),
      );
      expect(JSON.parse(res.content)).toEqual({ error: REFUSED });
    } else if (via === '新建或覆盖') {
      expect(toSource(await pages.act('workflows', 'defineWorkflow', { input: { yaml: BLOCKED_YAML } }))).toEqual({
        status: 500,
        body: { error: REFUSED },
      });
    } else {
      await expect(svc.defineWorkflow(onEvent('inbound:message'))).rejects.toThrow(REFUSED);
    }
    expect(svc.getWorkflow('zz-wf')).toBeUndefined();
    expect(existsSync(defFile())).toBe(false);
  });

  it('已在定义目录里的：照常载入，触发器不注册、记 warn 写明怎么办，文件不动；停用要重写定义，同样报错', async () => {
    writeFileSync(defFile(), BLOCKED_YAML);
    const { svc } = await boot();
    expect(svc.getWorkflow('zz-wf')).toBeDefined();
    expect(warnings).toContainEqual(
      expect.stringMatching(/"zz-wf" 的 event 触发器订阅的 "inbound:message".*；改掉触发器重新保存，或删掉这个定义$/),
    );
    expect(toSource(await pages.act('workflows', 'disableWorkflow', { rowKey: 'zz-wf' }))).toEqual({
      status: 500,
      body: { error: REFUSED },
    });
    expect(readFileSync(defFile(), 'utf8')).toBe(BLOCKED_YAML);
  });
});

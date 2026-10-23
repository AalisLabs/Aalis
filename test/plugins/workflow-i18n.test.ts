import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import type { WorkflowRun } from '../../packages/api-workflow/src/index.js';
import type { App, Logger } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { runDag } from '../../packages/plugin-workflow/src/engine.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { defineTexts, resolveText } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, setHostLanguage } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { toolRequest } from '../fixtures/tool-call.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 工作流运行的错误原因可以是文字对象：节点失败的那一句在 plugin-workflow 的字典里，接住的报错作参数、落盘前截到 200 字。
// 运行历史重启读回时文字对象仍在。WebUI 的工作流页（REST）按全局层的语言渲染运行表与「立即运行」的报错：en 拿英文，
// zh-CN 拿原文；交给模型的运行历史取原文。
// 真的 storage-local、tools、cron-engine、plugin-workflow、webui-server 与 plugin-i18n，全局语言写在宿主配置文档里 plugin-i18n 的配置段。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-workflow-i18n-token-placeholder-0';
const INSTANCE = encodeURIComponent('@aalis/plugin-workflow');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const t = defineTexts({
  ns: '@zz/workflow-i18n',
  language: 'zh-CN',
  source: { quota: '额度用完了' } as const,
  locales: { en: { quota: 'Out of quota' } },
});

const MANUAL_YAML = `id: zz-manual
trigger:
  type: manual
nodes:
  - id: a
    type: tool
    tool: zz_count
`;

/** 落盘的一条运行：原因是文字对象 */
const STORED: WorkflowRun = {
  runId: 'zz-text',
  workflowId: 'zz-manual',
  status: 'failed',
  triggerSource: 'manual:webui',
  startedAt: 1,
  finishedAt: 2,
  vars: {},
  nodes: [{ id: 'a', type: 'tool', status: 'failed', error: t('quota') }],
  error: t('quota'),
};

const apps: App[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

async function boot() {
  const base = mkdtempSync(join(tmpdir(), 'aalis-workflow-i18n-'));
  bases.push(base);
  mkdirSync(join(base, 'workspace', 'workflows'), { recursive: true });
  writeFileSync(join(base, 'workspace', 'workflows', 'zz-manual.yaml'), MANUAL_YAML);
  mkdirSync(join(base, 'state'), { recursive: true });
  writeFileSync(join(base, 'state', 'workflow-runs.json'), JSON.stringify({ runs: [STORED] }));
  const port = await freePort();
  const { app } = hostedApp(i18nSection(['en']), { logger: silent });
  apps.push(app);
  await registerHubs(app);
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
  const setLanguage = (language: string[]) => setHostLanguage(app, language);
  await app.plugin(i18nPlugin);
  await app.plugin(workflowPlugin, {});
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pages/${INSTANCE}/workflows/${path}`, {
      method,
      headers: {
        cookie: `aalis_webui_token=${TOKEN}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res.json();
  };
  /** 运行表里预置的那条的状态与原因 */
  const runs = async () => {
    const { data } = (await request('data/runs')) as {
      data: Array<{ runId: string; status: { text: string }; error: string }>;
    };
    return data.filter(r => r.runId.startsWith('zz-')).map(({ runId, status, error }) => ({ runId, status, error }));
  };
  return { app, request, runs, setLanguage };
}

describe('工作流运行的错误原因', () => {
  it('节点失败：原因是本插件字典里的文字对象，接住的报错作参数并截到 200 字', async () => {
    const result = await runDag({
      def: { id: 'zz', trigger: { type: 'manual' }, nodes: [{ id: 'a', type: 'tool', tool: 'x' }] },
      tools: {
        present: true,
        use: {
          execute: async () => {
            throw new Error('x'.repeat(300));
          },
        },
      } as never,
      events: { emit: async () => {} } as never,
      hooks: {} as never,
      logger: silent,
      runId: 'zz-run',
      vars: {},
      toolCallContext: { sessionId: 'zz', platform: 'workflow', participants: [{ platform: 'workflow', userId: '' }] },
      signal: new AbortController().signal,
    });
    expect(result.error).toMatchObject({ i18n: '@aalis/plugin-workflow', key: 'nodeFailed' });
    expect(resolveText(result.error as never, ['en'])).toBe(`Node "a" failed: ${'x'.repeat(200)}`);
  });

  it('落盘的原因重启读回：文字对象仍在、按全局层的语言渲染；交给模型的取原文', async () => {
    const { app, runs, setLanguage } = await boot();
    expect(await runs()).toEqual([
      { runId: 'zz-text', status: { text: 'Failed', state: 'error' }, error: 'Out of quota' },
    ]);
    setLanguage(['zh-CN']);
    expect(await runs()).toEqual([{ runId: 'zz-text', status: { text: '失败', state: 'error' }, error: '额度用完了' }]);
    const forModel = await app
      .bind({ tools })
      .tools.use.execute(
        'workflow_get_runs',
        {},
        toolRequest({ sessionId: 'zz', platform: 'webui', userId: 'console' }),
      );
    const listed = JSON.parse(forModel.content).runs as Array<{ runId: string; error?: unknown }>;
    expect(listed.filter(r => r.runId.startsWith('zz-'))).toMatchObject([{ runId: 'zz-text', error: '额度用完了' }]);
  });

  it('「立即运行」没有成功：报错按全局层的语言', async () => {
    const { app, request, setLanguage } = await boot();
    // 工具服务不在：tool 节点失败，这一次运行以失败收尾
    await app.plugins.unload(toolsPlugin.name);
    expect(await request('actions/runWorkflow', 'POST', { rowKey: 'zz-manual' })).toEqual({
      error: 'Run did not succeed (Failed): Node "a" failed: \'tools\' 服务不可用',
    });
    setLanguage(['zh-CN']);
    expect(await request('actions/runWorkflow', 'POST', { rowKey: 'zz-manual' })).toEqual({
      error: '运行没有成功（失败）：节点 "a" 失败: \'tools\' 服务不可用',
    });
  });
});

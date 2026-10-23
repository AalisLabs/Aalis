import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { client } from '../fixtures/session-client.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 后台任务的中断原因是宿主写的文字对象（plugin-tools 的字典），经会话协议的后台任务推送按全局默认层的语言渲染：en 拿英文，
// zh-CN 拿原文，i18n 缺席时一律原文。工具注册表、会话管理与会话服务都是真的，i18n 是真的 plugin-i18n。
// ════════════════════════════════════════════════════════════

const BG = 'zz_bg';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 全局语言（plugin-i18n 的配置段）是 language；返回后台任务推送里中断原因的取法 */
async function setup({ withI18n = true, language }: { withI18n?: boolean; language: string[] }) {
  const { app } = hostedApp(i18nSection(language), { logger: silent });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-session-background-i18n-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({ provide, tools, sessionManager, sessionProtocol });
  host.provide.use(storage, memoryStorage(new Map()));
  const plugins = [
    memoryInMemoryPlugin,
    toolsPlugin,
    sessionManagerPlugin,
    sessionServerPlugin,
    ...(withI18n ? [i18nPlugin] : []),
  ];
  await app.pluginAll(plugins.map(definition => ({ definition, config: {} })));
  await app.plugins.idle();
  for (const { name } of plugins) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  /** 可转后台的测试工具：一直挂着，直到这次调用被中止 */
  const withdraw = host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: BG, description: '可转后台的测试工具', parameters: { type: 'object', properties: {} } },
    },
    background: {},
    handler: (_args: Record<string, unknown>, ctx: ToolCallContext) =>
      new Promise<string>(resolve => {
        ctx.signal?.addEventListener('abort', () => resolve('{}'), { once: true });
      }),
  });
  const { id: sessionId } = await host.sessionManager.use.createSession({ name: '<会话>' });
  const c = client(host.sessionProtocol.use);
  await c.init();
  await c.call('background/watch', {});
  await host.tools.use.execute(
    BG,
    { runInBackground: true },
    toolRequest({ sessionId, platform: 'webui', userId: 'console', inbound: {}, turnId: 'zz-turn', callId: 'zz-call' }),
  );
  // 工具撤回登记：后台的任务落成 aborted，原因是宿主写的「已撤回登记」
  withdraw();
  /** 最近推出的这个任务的原因 */
  return async () => {
    await vi.waitFor(() => expect(c.notifications('background/changed').at(-1)?.upserts[0]?.status).toBe('aborted'));
    return c.notifications('background/changed').at(-1)?.upserts[0]?.reason;
  };
}

describe('后台任务推送里的中断原因按全局默认层的语言渲染', () => {
  it.each([
    ['en', `Tool ${BG} was unregistered`],
    ['zh-CN', `工具 ${BG} 已撤回登记`],
  ])('全局默认层为 %s', async (language, expected) => {
    const reason = await setup({ language: [language] });
    expect(await reason()).toBe(expected);
  });

  it('i18n 缺席时一律原文', async () => {
    const reason = await setup({ withI18n: false, language: ['en'] });
    expect(await reason()).toBe(`工具 ${BG} 已撤回登记`);
  });
});

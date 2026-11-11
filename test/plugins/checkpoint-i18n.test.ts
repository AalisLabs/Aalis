import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { type App, events, type Logger, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import checkpointPlugin from '../../packages/plugin-checkpoint/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { registerFileTools } from '../../packages/plugin-tool-system/src/tools/file.js';
import { type OutgoingMessage, WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { i18nSection } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { seedRooms } from '../fixtures/rooms.js';
import { client } from '../fixtures/session-client.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 检查点与本地存储给人看的原因按读者的语言：回滚结果里没回滚成的原因（turn/rewind 的 errors[].reason，会话协议按全局层的
// 语言）、/clear 清检查点的结果行（网关按房间的语言）。存储的报错两用：经回滚给人看是文字对象，经文件工具给模型的结果是原文。
// 真的 plugin-storage-local（根在临时目录里）、plugin-checkpoint（每个会话都记、单文件上限 1024 字节）与 plugin-i18n；回滚那组
// 的记忆是替身，没有 deleteMessagesByTimestamps。
// ════════════════════════════════════════════════════════════

const CHAT = 'zz-chat';
const ROOM = `${CHAT}:bot:group:1`;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 数据目录与工作根都在临时目录里；outside 是工作根以外的目录 */
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-checkpoint-i18n-'));
  homes.push(dir);
  const workspace = join(dir, 'workspace');
  const outside = join(dir, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  return { dir, workspace, outside };
}

const STORAGE_CONFIG = (workspace: string) => ({
  roots: [{ name: 'workspace', path: workspace, readable: true, writable: true, deletable: true }],
});
const CHECKPOINT_CONFIG = { coverage: 'all', maxFileSize: 1024 };
/** 宿主配置文档：coverage 是按会话字段，全局层读文档里本实例的那一段 */
const doc = (language?: string[]) => ({
  plugins: { ...(language ? i18nSection(language).plugins : {}), [checkpointPlugin.name]: CHECKPOINT_CONFIG },
});

/** 发起一轮：checkpoint 的 agent:turn:before 中间件把 inside 里的存储改动记进这一轮 */
async function turn(app: App, sessionId: string, turnId: string, inside: (store: StorageService) => Promise<void>) {
  const host = app.bind({ hooks, storage });
  const message = { content: '<改文件>', sessionId, platform: 'webui' };
  await host.hooks.use.run('agent:turn:before', { turnId, sessionId, inputs: [{ message }] }, () =>
    inside(host.storage.use),
  );
}

describe('回滚结果里的原因按全局层的语言', () => {
  async function setup(language = 'en') {
    const paths = home();
    const { app } = hostedApp(doc([language]), { logger: silent });
    apps.push(app);
    provideHostPaths(app, paths.dir);
    await registerHubs(app);
    // 记忆替身：会话管理用的几项，加上提交回合时 checkpoint 读的消息（一条，属于回合 zz-chat）；删不了消息
    const standIn = {
      ...fakeMemory(),
      getMessagesBySessionRange: async (_sessionId: string, from: number) => [
        {
          role: 'user',
          content: '<A>',
          timestamp: from + 200,
          metadata: { [WellKnownMetadataKeys.TurnId]: 'zz-chat' },
        },
      ],
    };
    app.bind({ provide }).provide.use(memory, standIn as never);
    const plugins: Array<{ definition: PluginDefinition; config?: Record<string, unknown> }> = [
      { definition: storageLocalPlugin, config: STORAGE_CONFIG(paths.workspace) },
      { definition: checkpointPlugin, config: CHECKPOINT_CONFIG },
      { definition: sessionManagerPlugin },
      { definition: sessionServerPlugin },
      { definition: i18nPlugin },
    ];
    await app.pluginAll(plugins.map(({ definition, config }) => ({ definition, config: config ?? {} })));
    await app.plugins.idle();
    for (const { definition } of plugins) {
      const state = app.plugins.getPlugin(definition.name)?.state;
      if (state !== 'active') throw new Error(`${definition.name} 未激活（state=${state}）`);
    }
    const host = app.bind({ sessionManager, sessionProtocol, storage });
    const c = client(host.sessionProtocol.use);
    await c.init();
    const { id: sessionId } = await host.sessionManager.use.createSession({ name: '<会话>' });
    return { app, paths, c, sessionId, store: host.storage.use };
  }

  const REASONS = {
    en: [
      'Invalid path',
      'File too large (2048 > 1024)',
      'The checkpoint does not exist',
      'The current memory backend does not support deleteMessagesByTimestamps',
    ],
    'zh-CN': [
      '路径不合法',
      '文件过大 (2048 > 1024)',
      'checkpoint 不存在',
      '当前 memory 后端不支持 deleteMessagesByTimestamps',
    ],
  };

  it.each(
    Object.entries(REASONS),
  )('%s：超过上限没快照的文件、存储报「路径不合法」、不存在的检查点、连对话回滚时记忆后端删不了消息；写入方存的原因是文字对象', async (language, expected) => {
    const { app, paths, c, sessionId, store } = await setup(language);
    writeFileSync(join(paths.workspace, 'big.bin'), Buffer.alloc(2048));
    await turn(app, sessionId, 'zz-turn', async storage => {
      await storage.writeFile('workspace:/big.bin', 'x');
      await storage.writeFile('workspace:/new.txt', 'n');
    });
    // 新建的文件换成指到工作根外面的链接：回滚删它时存储拒绝
    unlinkSync(join(paths.workspace, 'new.txt'));
    symlinkSync(join(paths.outside, 'target.txt'), join(paths.workspace, 'new.txt'));
    writeFileSync(join(paths.outside, 'target.txt'), 'outside');
    // 只有消息、没有文件改动的一轮
    await turn(app, sessionId, 'zz-chat', async () => {});

    const rewind = async (turnId: string, scope: 'code' | 'code-and-chat' = 'code') =>
      (await c.call('turn/rewind', { sessionId, turnId, scope })).errors.map(e => e.reason);
    expect([
      ...(await rewind('zz-turn')),
      ...(await rewind('zz-none')),
      ...(await rewind('zz-chat', 'code-and-chat')),
    ]).toEqual(expected);
    const manifests = await store.list('data:/checkpoints');
    const [sessionDir] = manifests.entries.map(e => e.name);
    const manifest = JSON.parse(String(await store.readFile(`data:/checkpoints/${sessionDir}/zz-turn/manifest.json`)));
    expect(manifest.files.find((f: { uri: string }) => f.uri === 'workspace:/big.bin').skipped).toMatchObject({
      i18n: '@aalis/plugin-checkpoint',
      key: 'tooLarge',
      params: { size: 2048, max: 1024 },
    });
  });

  it('同一个存储报错经文件工具给模型：结果是原文', async () => {
    const { paths, store } = await setup();
    symlinkSync(paths.outside, join(paths.workspace, 'link'));
    writeFileSync(join(paths.outside, 'target.txt'), 'outside');
    const tools: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
    registerFileTools(
      stubBoundTools({
        onRegister: tool => {
          tools[tool.definition.function.name] = tool;
        },
      }),
      {
        maxReadSize: 1048576,
        maxSearchBytes: 1048576,
        maxWriteSize: 10485760,
        allowedRoots: ['workspace'],
        storage: store,
        cwdState: { get: () => 'workspace:/' },
      } as never,
    );
    const result = await tools.file_read?.handler(
      { path: 'workspace:/link/target.txt' },
      toolContext({ sessionId: 'zz-s' }),
    );
    expect(result).toBe(JSON.stringify({ error: '路径不合法' }));
  });
});

describe('/clear 清检查点的结果行按房间的语言', () => {
  it.each([
    [
      'en',
      [
        'This session has no checkpoints',
        'Cleared the checkpoints of this session (1 turn)',
        'Cleared all checkpoints (1 session)',
      ],
    ],
    ['zh-CN', ['当前会话无检查点', '当前会话的检查点已清空（1 轮）', '所有检查点已清空（1 个会话）']],
  ])('%s 房间：没有检查点、清本会话、清全部', async (language, expected) => {
    const paths = home();
    const { app } = hostedApp(doc(), { logger: silent });
    apps.push(app);
    provideHostPaths(app, paths.dir);
    await registerHubs(app);
    await app.plugin(memoryInMemory);
    await app.plugins.idle();
    await seedRooms(app.bind({ memory }).memory.use, { [ROOM]: ROOM });
    const plugins: Array<{ definition: PluginDefinition; config?: Record<string, unknown> }> = [
      { definition: storageLocalPlugin, config: STORAGE_CONFIG(paths.workspace) },
      { definition: checkpointPlugin, config: CHECKPOINT_CONFIG },
      { definition: sessionManagerPlugin },
      { definition: sessionSettingsPlugin },
      { definition: gatewayPlugin },
      { definition: commandsPlugin },
      { definition: i18nPlugin },
    ];
    await app.pluginAll(plugins.map(({ definition, config }) => ({ definition, config: config ?? {} })));
    await app.plugins.idle();
    const host = app.bind({ provide, events, commands, gateway, sessionSettings });
    // 权限插件的执行守卫：一律放行（/clear 要确认，没有守卫时拒绝执行）
    host.commands.use.setExecutionGuard(async () => ({ ok: true }));
    await host.sessionSettings.use.update(
      { sessionId: ROOM },
      { plugin: i18nPlugin.name, key: 'language', value: [language] },
    );
    const sent: OutgoingMessage[] = [];
    host.events.use.on('outbound:message', message => {
      if (message.platform === CHAT) sent.push(message);
    });
    const ask = async (content: string) => {
      const before = sent.length;
      void host.gateway.use.ingressMessage({ content, sessionId: ROOM, platform: CHAT, userId: 'zz-user' });
      await vi.waitFor(() => expect(sent.length).toBe(before + 1));
      return sent[before].content;
    };
    const edit = (n: number) =>
      turn(app, ROOM, `zz-turn-${n}`, storage => storage.writeFile('workspace:/a.txt', `${n}`));

    const replies = [await ask('/clear -t checkpoint')];
    await edit(1);
    replies.push(await ask('/clear -t checkpoint'));
    await edit(2);
    replies.push(await ask('/clear all -t checkpoint'));
    expect(replies).toEqual(expected);
  });
});

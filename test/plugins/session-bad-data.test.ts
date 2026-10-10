import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type SessionItem, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, type Logger, provide } from '../../packages/core/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import { type IncomingMessage, type Message, WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { client } from '../fixtures/session-client.js';

// ════════════════════════════════════════════════════════════
// 坏数据只坏它自己：会话表与存档里写进形状不对的记录（存储里的旧数据、手改或别的插件写坏的），会话列表、快照与历史照常给出，
// 坏的那条以外的都在。测试客户端按协议的 schema 收结果，坏数据漏到协议里也算失败
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const warnings: string[] = [];
const logger: Logger = {
  debug() {},
  info() {},
  warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')),
  error() {},
  child: () => logger,
};

/** 先把会话表与存档写进内存记忆，再装会话管理与会话服务：会话管理装上时读会话表 */
async function setup(records: Record<string, unknown>, archive: Record<string, unknown[]> = {}) {
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-bad-data-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  await app.plugins.idle();
  const host = app.bind({ provide, events, memory, sessionProtocol });
  host.provide.use(storage, memoryStorage(new Map()));
  host.provide.use(authority, { isOwner: (p: string, u?: string) => p === 'webui' && u === 'console' } as never);
  const mem = host.memory.use;
  for (const [key, data] of Object.entries(records)) await mem.saveMetadata('sessions', key, data as never);
  for (const [sessionId, messages] of Object.entries(archive)) {
    for (const message of messages) await mem.saveMessage(sessionId, message as Message);
  }
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  await app.plugins.idle();
  const c = client(host.sessionProtocol.use);
  await c.init();
  return { c, mem, events: host.events };
}

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  children: [],
  status: 'completed',
  config: {},
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});

const owner = { [WellKnownMetadataKeys.Platform]: 'webui', [WellKnownMetadataKeys.UserId]: 'console' };
const ask = (content: string, timestamp: number): Message => ({ role: 'user', content, timestamp, metadata: owner });

/** 条目压成便于比对的样子 */
function brief(item: SessionItem): string {
  if (item.kind === 'user-message' || item.kind === 'agent-message') return `${item.kind}:${item.text}`;
  if (item.kind === 'tool-call') return `tool-call:${item.name}:${item.status}`;
  return item.kind;
}

describe('坏数据只坏它自己', () => {
  beforeEach(() => {
    warnings.length = 0;
  });

  it('会话表里必填字段不对的记录不载入、记告警、移到 sessions-rejected；可选字段类型不对的去掉这个字段照常载入；会话列表照常给出，好的会话都在', async () => {
    const rejected = {
      'webui:children': record('webui:children', { children: null }),
      'webui:name': record('webui:name', { name: 7 }),
      'webui:times': record('webui:times', { updatedAt: '昨天' }),
      'webui:status': record('webui:status', { status: 'weird' }),
      'webui:config': record('webui:config', { config: 'x' }),
      'webui:key': record('webui:other'),
    };
    const { c, mem } = await setup({
      'webui:good': record('webui:good', { title: '好的' }),
      // 存储把没有的可选字段存成 null（MongoDB 就是这样）：照常载入，当作没有
      'webui:nulls': record('webui:nulls', {
        title: null,
        parentId: null,
        metadata: null,
        inputContext: null,
        originInstance: null,
        lastReplyAt: null,
        lastTurn: null,
        tokens: null,
      }),
      'webui:orphan': record('webui:orphan', { parentId: 'webui:missing', children: ['webui:nobody'] }),
      'webui:title': record('webui:title', { title: { text: '标题' } }),
      'webui:turn': record('webui:turn', { status: 'error', lastTurn: 'x' }),
      'webui:tokens': record('webui:tokens', { tokens: { input: 'many', output: 1 } }),
      // 没有读者会因类型不对出错的字段不核
      'webui:metadata': record('webui:metadata', { metadata: 3, result: 1 }),
      ...rejected,
    });
    const { sessions } = await c.list();
    expect(sessions.map(s => s.id).sort()).toEqual([
      'webui:good',
      'webui:metadata',
      'webui:nulls',
      'webui:title',
      'webui:tokens',
      'webui:turn',
    ]);
    expect(sessions.find(s => s.id === 'webui:nulls')).not.toHaveProperty('parentId');
    expect(sessions.find(s => s.id === 'webui:title')?.title, '去掉了标题，显示名称').toBe('webui:title');
    expect(sessions.find(s => s.id === 'webui:tokens')).not.toHaveProperty('tokens');
    expect(sessions.find(s => s.id === 'webui:turn')).not.toHaveProperty('lastTurn');
    expect(await c.list({ query: '好' })).toMatchObject({ sessions: [{ id: 'webui:good' }] });
    const warned = warnings.join('\n');
    for (const dropped of ['webui:title（title）', 'webui:turn（lastTurn）', 'webui:tokens（tokens）']) {
      expect(warned).toContain(dropped);
    }
    expect(warned).not.toContain('webui:metadata');
    for (const [key, data] of Object.entries(rejected)) {
      expect(warned).toContain(key);
      expect(await mem.getMetadata('sessions', key)).toBeUndefined();
      expect(await mem.getMetadata('sessions-rejected', key)).toEqual(data);
    }
  });

  it('不载入或去掉了字段的房间再来消息：建档不覆盖原记录，去掉的字段之外的配置都在', async () => {
    const stripped = 'onebot:1:group:2';
    const broken = 'onebot:1:group:3';
    const original = record(broken, { children: null, config: { persona: 'Y' } });
    const { mem, events } = await setup({
      [stripped]: record(stripped, { config: { persona: 'X' }, tokens: { input: 'many', output: 1 } }),
      [broken]: original,
    });
    for (const sessionId of [stripped, broken]) {
      const msg: IncomingMessage = { sessionId, platform: 'onebot', userId: '7', content: '在吗', groupId: '2' };
      await events.use.emit('inbound:message', msg);
    }
    // 等新建的房间落盘
    await vi.waitFor(async () => expect((await mem.getMetadata('sessions', broken))?.children).toEqual([]), {
      timeout: 3000,
    });
    expect(await mem.getMetadata('sessions', stripped)).toMatchObject({ config: { persona: 'X' }, createdAt: 1 });
    expect(await mem.getMetadata('sessions-rejected', broken)).toEqual(original);
  });

  it('存档里字段类型不对的消息：快照与历史照常给出，坏消息前后的条目都在，没进历史的记告警', async () => {
    const id = 'webui:archive';
    const bad = [
      { role: 'assistant', content: '坏的调用', toolCalls: [{ id: 'x' }], timestamp: 3 },
      { role: 'assistant', content: null, toolCalls: 'oops', timestamp: 4 },
      { role: 'assistant', content: '', segments: 'oops', timestamp: 5 },
      { role: 'assistant', content: '', segments: [null, { type: 'tool_call', name: 5 }], timestamp: 6 },
      { role: 'assistant', content: '想', reasoningContent: 5, timestamp: 7 },
      { role: 'user', content: 42, timestamp: 8, metadata: owner },
      { role: 'user', content: '时间不对', timestamp: '昨天', metadata: owner },
      { role: 'user', content: '元数据不对', timestamp: 9, metadata: 'x' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'y', function: { name: 'read', arguments: '{}' } }],
        timestamp: 10,
      },
      { role: 'tool', content: { not: 'text' }, toolCallId: 'y', timestamp: 11 },
      {
        role: 'assistant',
        content: '模型信息不对',
        timestamp: 12,
        metadata: { [WellKnownMetadataKeys.ModelInfo]: 'x', [WellKnownMetadataKeys.TurnId]: 3 },
      },
    ];
    const { c } = await setup({ [id]: record(id) }, { [id]: [ask('之前', 1), ...bad, ask('之后', 20)] });
    const { snapshot } = await c.subscribe(id);
    const shown = snapshot.items.map(brief);
    expect(shown[0]).toBe('user-message:之前');
    expect(shown.at(-1)).toBe('user-message:之后');
    const history = await c.call('session/history', { sessionId: id, limit: 3 });
    expect(history.items.map(brief).at(-1)).toBe('user-message:之后');
    // 没进历史的写明是哪个会话、几条，不默默丢掉
    expect(warnings.filter(line => line.includes(id))).toContainEqual(expect.stringContaining('9 条'));
  });

  it('重复的 callId、只有调用没有结果、断在半截的回合：只影响自己那几条', async () => {
    const id = 'webui:turns';
    const call = (callId: string, name: string) => ({ id: callId, function: { name, arguments: '{}' } });
    const { c } = await setup(
      { [id]: record(id) },
      {
        [id]: [
          ask('一', 1),
          { role: 'assistant', content: '', toolCalls: [call('c1', 'read'), call('c1', 'read')], timestamp: 2 },
          { role: 'tool', content: '甲', toolCallId: 'c1', timestamp: 3, metadata: { callId: 'dup' } },
          { role: 'tool', content: '乙', toolCallId: 'c1', timestamp: 4, metadata: { callId: 'dup' } },
          { role: 'assistant', content: '读完了', timestamp: 5 },
          ask('二', 6),
          { role: 'assistant', content: '', toolCalls: [call('c2', 'exec')], timestamp: 7 },
          ask('三', 8),
          { role: 'tool', content: '没人认领的结果', toolCallId: 'c9', timestamp: 9 },
          { role: 'assistant', content: '答三', timestamp: 10 },
        ],
      },
    );
    const { snapshot } = await c.subscribe(id);
    const shown = snapshot.items.map(brief);
    expect(shown).toContain('user-message:二');
    expect(shown).toContain('tool-call:exec:aborted');
    expect(shown.slice(-2)).toEqual(['user-message:三', 'agent-message:答三']);
  });
});

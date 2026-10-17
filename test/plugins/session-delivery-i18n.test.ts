import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type SessionItem, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type App, definePlugin, events, type Logger, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import { defineTexts, type Localized } from '../../packages/schema-i18n/src/index.js';
import {
  type IncomingMessage,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { recordRoom } from '../fixtures/rooms.js';
import { client } from '../fixtures/session-client.js';

// ════════════════════════════════════════════════════════════
// 房间里她的话没发出去时，时间线写的原因按全局默认层的语言渲染：适配器交来的送达原因是文字对象时，实时推送与重连之后的
// 历史（适配器记下的投递失败，元数据 DeliveryError 存文字对象）都按这种语言显示；会话服务自己写的原因（静默结束等）进它的
// 字典。i18n 是真的 plugin-i18n。
// ════════════════════════════════════════════════════════════

const NS = '@zz/session-delivery-i18n';
const t = defineTexts({
  ns: NS,
  language: 'zh-CN',
  source: { disbanded: '群已解散' } as const,
  locales: { en: { disbanded: 'The group was disbanded' } },
});

const ROOM = 'onebot:10000:group:1';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 接管这个房间的 OneBot 适配器（只用来认房间，发送不经它） */
const adapterPlugin = definePlugin({
  name: 'zz-delivery-adapter',
  provides: [platform],
  uses: { provide },
  apply: ({ provide }) => {
    provide.use(platform, {
      platform: 'onebot',
      canHandle: (id: string) => id.startsWith('onebot:10000:'),
      getConnections: () => [],
      sendMessage: async () => {},
    } as never);
  },
});

/**
 * 会话服务连同会话管理、内存记忆、消息归档与 i18n，房间已收录；存储与 owner 判定是替身。全局默认层的语言是 en，
 * setLanguage 改它。平台没收下她发进房间的消息：送达结果的原因是文字对象，并像适配器一样记下投递失败
 */
async function setup() {
  const { app } = hostedApp({ sessionConfig: { defaults: { language: ['en'] } } }, { logger: silent });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-delivery-i18n-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, messageArchive, sessionManager, sessionProtocol });
  host.provide.use(storage, memoryStorage(new Map()));
  host.provide.use(authority, { isOwner: () => false } as never);
  await app.plugin(adapterPlugin);
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  await app.plugin(i18nPlugin);
  await app.plugins.idle();
  for (const plugin of [sessionServerPlugin, i18nPlugin]) {
    const state = app.plugins.getPlugin(plugin.name)?.state;
    if (state !== 'active') throw new Error(`${plugin.name} 未激活（state=${state}）`);
  }
  await recordRoom(host.events.use, ROOM, '群');
  const error = t('disbanded');
  host.events.use.on('outbound:message', msg => {
    if (msg.sessionId !== ROOM || msg.delivery) return;
    msg.delivery = (async () => {
      await host.messageArchive.use.saveMessage(ROOM, {
        role: 'system',
        kind: WellKnownKinds.OutboundDeliveryFailed,
        content: '[投递回报] 你刚才发送的内容未能送达对方',
        metadata: { [WellKnownMetadataKeys.DeliveryError]: error, [WellKnownMetadataKeys.TurnId]: msg.turnId },
      });
      return { ok: false, error };
    })();
  });

  /** 房间里的一轮：她说了 said；replied 时这就是回复（落库并发进房间），否则这一轮静默结束 */
  const turn = (turnId: string, said: string, outcome: 'replied' | 'silent') => {
    const message: IncomingMessage = { content: '<提问>', sessionId: ROOM, platform: 'onebot', userId: '424242' };
    return host.hooks.use.run('agent:input:before', { message, turnId, metadata: {} }, async () => {
      await host.events.use.emit('outbound:stream', {
        sessionId: ROOM,
        turnId,
        platform: 'onebot',
        contentDelta: said,
      });
      await host.hooks.use.run('agent:reply:before', { content: '', sessionId: ROOM, attempt: 0 });
      if (outcome === 'replied') {
        await host.messageArchive.use.saveMessage(ROOM, {
          role: 'assistant',
          content: said,
          segments: [{ type: 'text', content: said }],
          metadata: { [WellKnownMetadataKeys.TurnId]: turnId },
        });
        await host.events.use.emit('outbound:message', {
          content: said,
          sessionId: ROOM,
          platform: 'onebot',
          source: 'agent',
          turnId,
        });
      }
      await host.hooks.use.run('agent:turn:after', {
        message,
        reply: '',
        outcome,
        sessionId: ROOM,
        turnId,
        metadata: {},
      });
    });
  };

  const connect = async () => {
    const c = client(host.sessionProtocol.use);
    await c.init();
    return c;
  };
  const setLanguage = (language: string[]) => host.sessionManager.use.updateLayer({ scope: 'defaults' }, { language });
  return { turn, connect, setLanguage };
}

/** 她说的话与没发出的原因 */
const reasons = (items: Localized<SessionItem>[]) =>
  items.flatMap(item => (item.kind === 'agent-message' ? [[item.text, item.undelivered?.reason]] : []));

describe('没发出的原因按全局默认层的语言', () => {
  it('平台没收下、原因是文字对象：实时推送与重连之后的历史都按全局默认层的语言显示', async () => {
    const { turn, connect, setLanguage } = await setup();
    const live = await connect();
    const base = await live.subscribe(ROOM);
    await turn('turn-1', '晚安', 'replied');
    const english = [['晚安', 'Not sent: the platform did not accept it (The group was disbanded)']];
    await vi.waitFor(() => expect(reasons(live.timeline(ROOM, base))).toEqual(english));

    const history = async () => reasons((await (await connect()).subscribe(ROOM)).snapshot.items);
    expect(await history()).toEqual(english);
    await setLanguage(['zh-CN']);
    expect(await history()).toEqual([['晚安', '没有发出：平台没收下（群已解散）']]);
  });

  it('会话服务自己写的原因（这一轮静默结束）按全局默认层的语言', async () => {
    const { turn, connect, setLanguage } = await setup();
    const live = await connect();
    const base = await live.subscribe(ROOM);
    await turn('turn-1', '想说又没说', 'silent');
    await setLanguage(['zh-CN']);
    await turn('turn-2', '还是没说', 'silent');
    expect(reasons(live.timeline(ROOM, base))).toEqual([
      ['想说又没说', 'Not sent: this turn ended silently'],
      ['还是没说', '没有发出：这一轮静默结束'],
    ]);
  });
});

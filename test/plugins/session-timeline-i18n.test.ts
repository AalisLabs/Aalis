import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { compression, memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  COMMAND_REPLY_TOPIC,
  type SessionItem,
  sessionProtocol,
} from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type App, events, type Logger, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { defineTexts, type Localized, type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';
import {
  type OutgoingMessage,
  selfInitiatedActor,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, setHostLanguage } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { fakeSummaryLLM } from '../fixtures/memory-summary.js';
import { seedRooms } from '../fixtures/rooms.js';
import { client } from '../fixtures/session-client.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 时间线与历史按全局默认层的语言渲染：实时推送与重连之后的历史显示同一句话。夹具交出文字对象的三处写入方都是真的：
// webui-server 把带文字对象的出站记进 WebUI 会话的历史，memory-summary 写压缩分隔线，message-archive 记宿主通知、
// 平台通知与房间里送达了的非回复出站；会话服务的时间线固定句（压缩）进它自己的字典。存档的正文是原文（给模型与日志），
// 没记文字对象的旧记录照旧显示正文。i18n 是真的 plugin-i18n。
// ════════════════════════════════════════════════════════════

const NS = '@zz/session-timeline-i18n';
const t = defineTexts({
  ns: NS,
  language: 'zh-CN',
  source: {
    switched: '已切换到 {name}',
    stopped: '已停止 {name}',
    done: '报告 {id} 完成了',
    poked: '{who} 戳了戳你',
    requested: '用户 {user} 发来了好友申请',
  } as const,
  locales: {
    en: {
      switched: 'Switched to {name}',
      stopped: 'Stopped {name}',
      done: 'Report {id} is done',
      poked: '{who} poked you',
      requested: 'User {user} sent a friend request',
    },
  },
});

const OWNER = { platform: 'webui', userId: 'console' };

/** 预置在会话表里的房间 */
const ROOM = 'onebot:10000:group:20001';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * 会话服务连同会话管理、内存记忆、消息归档、记忆摘要（桩摘要模型）、webui-server（不监听，只用它的出站收件箱）与 i18n；
 * 存储与 owner 判定是替身，会话表里预置了 ROOM。全局默认层的语言是 en，setLanguage 改它
 */
async function setup() {
  const { app } = hostedApp(i18nSection(['en']), { logger: silent });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-timeline-i18n-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({
    provide,
    events,
    hooks,
    memory,
    messageArchive,
    compression,
    sessionManager,
    sessionProtocol,
  });
  host.provide.use(storage, memoryStorage(new Map()));
  host.provide.use(authority, {
    isOwner: (p: string, u?: string) => p === OWNER.platform && u === OWNER.userId,
  } as never);
  host.provide.use(llm, fakeSummaryLLM().model);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  await seedRooms(host.memory.use, { [ROOM]: '群' });
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  await app.plugin(memorySummary, {});
  await app.plugin(webuiServerPlugin, {
    port: await freePort(),
    host: '127.0.0.1',
    autoOpen: false,
    tokenMode: 'fixed',
    fixedToken: 'zz-timeline-i18n-token-placeholder-0',
  });
  await app.plugin(i18nPlugin);
  await app.plugins.idle();
  for (const plugin of [sessionServerPlugin, memorySummary, webuiServerPlugin, i18nPlugin]) {
    const state = app.plugins.getPlugin(plugin.name)?.state;
    if (state !== 'active') throw new Error(`${plugin.name} 未激活（state=${state}）`);
  }
  const connect = async () => {
    const c = client(host.sessionProtocol.use);
    await c.init();
    return c;
  };
  const setLanguage = async (language: string[]) => setHostLanguage(app, language);
  return { host, connect, setLanguage };
}

/** 条目里显示的文字：她的消息与通知 */
const shown = (items: Localized<SessionItem>[]) =>
  items.flatMap(item => (item.kind === 'agent-message' || item.kind === 'notice' ? [item.text] : []));

/** 她的消息与通知：种类、通知的 topic 与文字 */
const said = (items: Localized<SessionItem>[]) =>
  items.flatMap(item =>
    item.kind === 'agent-message' || item.kind === 'notice'
      ? [{ kind: item.kind, topic: item.kind === 'notice' ? item.topic : undefined, text: item.text }]
      : [],
  );

describe('时间线与历史按全局默认层的语言渲染', () => {
  it('带文字对象的非回复出站（回合外与回合中）：实时推成 notice，与重连之后历史里的那一条 kind、topic、text 相同；en 看到英文、zh-CN 是原文，参数里的 Markdown 原样；消息与存档的正文是原文', async () => {
    const { host, connect, setLanguage } = await setup();
    const live = await connect();
    const { session } = await live.call('session/create', {});
    const id = session.id;
    const base = await live.subscribe(id);
    const sent: OutgoingMessage[] = [];
    const send = async (text: TextRef) => {
      const out: OutgoingMessage = {
        sessionId: id,
        platform: 'webui',
        source: 'system',
        content: toSource(text),
        text,
      };
      sent.push(out);
      await host.events.use.emit('outbound:message', out);
      expect(await out.delivery).toEqual({ ok: true });
    };
    const link = '[zz](https://e.com/model)';
    const image = '![zz](https://e.com/tool.png)';
    await send(t('switched', { name: link }));
    const asked = { content: '<提问>', sessionId: id, platform: OWNER.platform, userId: OWNER.userId };
    await host.hooks.use.run(
      'agent:turn:before',
      { turnId: 'turn-1', sessionId: asked.sessionId, inputs: [{ message: asked }] },
      () => send(t('stopped', { name: image })),
    );

    const notice = (text: string) => ({ kind: 'notice', topic: WellKnownKinds.EventMarker, text });
    const english = [notice(`Switched to ${link}`), notice(`Stopped ${image}`)];
    expect(said(live.timeline(id, base))).toEqual(english);
    const history = async () => said((await (await connect()).subscribe(id)).snapshot.items);
    expect(await history()).toEqual(english);
    await setLanguage(['zh-CN']);
    expect(await history()).toEqual([notice(`已切换到 ${link}`), notice(`已停止 ${image}`)]);
    const sources = [`已切换到 ${link}`, `已停止 ${image}`];
    expect(sent.map(out => out.content)).toEqual(sources);
    expect((await host.memory.use.getHistory(id, Infinity)).map(m => m.content)).toEqual(sources);
  });

  it('指令的回复（出站的 source 为 command）：实时与重连之后的历史都是 topic 为 command-reply 的通知，文字相同', async () => {
    const { host, connect } = await setup();
    const live = await connect();
    const { session } = await live.call('session/create', {});
    const id = session.id;
    const base = await live.subscribe(id);
    const send = async (out: Pick<OutgoingMessage, 'source' | 'content' | 'text'>) => {
      const message: OutgoingMessage = { sessionId: id, platform: 'webui', ...out };
      await host.events.use.emit('outbound:message', message);
      expect(await message.delivery).toEqual({ ok: true });
    };
    const list = '指令\n- /zz-a — 第一条\n  - all：全部';
    const switched = t('switched', { name: 'zz' });
    await send({ source: 'command', content: list });
    await send({ source: 'command', content: toSource(switched), text: switched });

    const expected = [
      { kind: 'notice', topic: COMMAND_REPLY_TOPIC, text: list },
      { kind: 'notice', topic: COMMAND_REPLY_TOPIC, text: 'Switched to zz' },
    ];
    expect(said(live.timeline(id, base))).toEqual(expected);
    expect(said((await (await connect()).subscribe(id)).snapshot.items)).toEqual(expected);
  });

  it('房间里不是她回复的出站文字：平台送达之后记进历史，实时与重连之后的历史是同样的通知；她的回复不在这里记', async () => {
    const { host, connect } = await setup();
    // 房间的平台适配器替身：认领出站，回执成功，送达之后发 outbound:delivered（同 OneBot、CLI）
    host.events.use.on('outbound:message', message => {
      if (message.sessionId !== ROOM || message.delivery) return;
      message.delivery = Promise.resolve({ ok: true });
      void host.events.use.emit('outbound:delivered', { ...message, delivery: undefined });
    });
    const live = await connect();
    const base = await live.subscribe(ROOM);
    const switched = t('switched', { name: 'zz' });
    const sent: OutgoingMessage[] = [
      { sessionId: ROOM, platform: 'onebot', source: 'command', content: toSource(switched), text: switched },
      { sessionId: ROOM, platform: 'onebot', source: 'system', content: '[错误] 出错了' },
      // 她的回复由 agent 存档
      { sessionId: ROOM, platform: 'onebot', source: 'agent', content: '在' },
    ];
    for (const message of sent) {
      await host.events.use.emit('outbound:message', message);
      expect(await message.delivery).toEqual({ ok: true });
    }

    const expected = [
      { kind: 'notice', topic: COMMAND_REPLY_TOPIC, text: 'Switched to zz' },
      { kind: 'notice', topic: WellKnownKinds.EventMarker, text: '[错误] 出错了' },
    ];
    expect(said(live.timeline(ROOM, base)).filter(item => item.kind === 'notice')).toEqual(expected);
    await vi.waitFor(async () =>
      expect(said((await (await connect()).subscribe(ROOM)).snapshot.items)).toEqual(expected),
    );
  });

  it('回合里发进房间的 [错误]（带这一轮的 turnId）：送达记进存档之后、回合还没收尾时取快照，只有一条', async () => {
    const { host, connect } = await setup();
    host.events.use.on('outbound:message', message => {
      if (message.sessionId !== ROOM || message.delivery) return;
      message.delivery = Promise.resolve({ ok: true });
      void host.events.use.emit('outbound:delivered', { ...message, delivery: undefined });
    });
    const asked = { content: '<提问>', sessionId: ROOM, platform: 'onebot', userId: '30001' };
    let inTurn: ReturnType<typeof said> = [];
    await host.hooks.use.run(
      'agent:turn:before',
      { turnId: 'turn-1', sessionId: asked.sessionId, inputs: [{ message: asked }] },
      async () => {
        const error: OutgoingMessage = {
          sessionId: ROOM,
          platform: 'onebot',
          source: 'system',
          turnId: 'turn-1',
          content: '[错误] 出错了',
        };
        await host.events.use.emit('outbound:message', error);
        expect(await error.delivery).toEqual({ ok: true });
        await vi.waitFor(async () =>
          expect((await host.memory.use.getHistory(ROOM, Infinity)).map(m => m.content)).toContain('[错误] 出错了'),
        );
        inTurn = said((await (await connect()).subscribe(ROOM)).snapshot.items);
      },
    );

    expect(inTurn).toEqual([{ kind: 'notice', topic: WellKnownKinds.EventMarker, text: '[错误] 出错了' }]);
  });

  it('WebUI 自己的会话里带附件的指令回复：文字由收件箱记一次，送达之后不再记一份', async () => {
    const { host, connect } = await setup();
    const { session } = await (await connect()).call('session/create', {});
    const message: OutgoingMessage = {
      sessionId: session.id,
      platform: 'webui',
      source: 'command',
      content: '图表如下',
      attachments: [{ kind: 'image', data: 'data:/images/chart.png' }],
    };
    await host.events.use.emit('outbound:message', message);
    expect(await message.delivery).toEqual({ ok: true });
    // outbound:delivered 的旁观者在后台记：等一拍再数
    await new Promise(resolve => setTimeout(resolve, 20));
    const markers = (await host.memory.use.getHistory(session.id, Infinity)).filter(
      stored => stored.kind === WellKnownKinds.EventMarker,
    );
    expect(markers.map(stored => stored.content)).toEqual(['图表如下']);
  });

  it('压缩分隔线与宿主通知在实时与历史里按全局默认层的语言显示；没记文字对象的旧记录照旧显示正文', async () => {
    const { host, connect } = await setup();
    const live = await connect();
    const { session } = await live.call('session/create', {});
    const id = session.id;
    const base = await live.subscribe(id);
    const archive = host.messageArchive.use;
    await archive.saveMessage(id, { role: 'user', content: '在吗', timestamp: 1 });
    await archive.saveMessage(id, { role: 'assistant', content: '在', timestamp: 2 });
    await host.compression.use.compress(id, { reason: 'manual' });
    const done = t('done', { id: 'n-1' });
    await archive.archiveIncoming({
      content: '[报告] 任务 n-1 结束，向用户转述结果',
      sessionId: id,
      platform: 'webui',
      source: 'zz-reporter:n-1',
      actor: selfInitiatedActor('webui'),
      hostNotice: { kind: 'zz-report', id: 'n-1', text: done },
    });
    const poked = t('poked', { who: 'zz-user' });
    await archive.archiveNotice?.({ sessionId: id, noticeType: 'poke', content: toSource(poked), text: poked });
    await archive.saveMessage(id, { role: 'system', kind: WellKnownKinds.EventMarker, content: '旧的分隔线' });
    await archive.saveMessage(id, {
      role: 'notice',
      kind: 'poke',
      content: '坏的文字对象',
      metadata: { [WellKnownMetadataKeys.Text]: { i18n: NS, key: 'poked' } },
    });

    const started = live
      .notifications('item/started')
      .flatMap(({ item }) => (item.kind === 'notice' ? [item.text] : []));
    expect(started).toEqual(['Compacting the conversation']);
    expect(shown(live.timeline(id, base))).toEqual(['Conversation compacted', 'Report n-1 is done']);
    const reopened = await connect();
    const { snapshot } = await reopened.subscribe(id);
    expect(shown(snapshot.items)).toEqual([
      '在',
      'Conversation compacted',
      'Report n-1 is done',
      'zz-user poked you',
      '旧的分隔线',
      '坏的文字对象',
    ]);
  });

  it('平台事件合成的入站带给人看的那句：实时与历史都画成按全局默认层的语言显示的通知，存档正文照旧是写给模型的原文', async () => {
    const { host, connect } = await setup();
    const live = await connect();
    const { session } = await live.call('session/create', {});
    const id = session.id;
    const base = await live.subscribe(id);
    const content = '[系统通知] 用户 30001 向我发出了好友申请。请决定是否同意，调用 zz_handle 工具处理。';
    await host.messageArchive.use.archiveIncoming({
      content,
      sessionId: id,
      platform: 'onebot',
      userId: '30001',
      source: 'zz-request',
      text: t('requested', { user: '30001' }),
    });
    const notice = { kind: 'notice', topic: 'zz-request', text: 'User 30001 sent a friend request' };
    expect(said(live.timeline(id, base))).toEqual([notice]);
    expect(said((await (await connect()).subscribe(id)).snapshot.items)).toEqual([notice]);
    const [stored] = await host.memory.use.getHistory(id, Infinity);
    // 带来源的注入不是任何人的发言，不带发送者前缀
    expect(stored).toMatchObject({ role: 'user', content });
  });

  it('平台事件转成的入站不带来源（如戳一戳）：通知的 topic 是它的 noticeType，存档仍是 user 消息、子类记成 kind', async () => {
    const { host, connect } = await setup();
    const live = await connect();
    const { session } = await live.call('session/create', {});
    const id = session.id;
    const base = await live.subscribe(id);
    await host.messageArchive.use.archiveIncoming({
      content: '[戳一戳: 30001 戳了你]',
      sessionId: id,
      platform: 'onebot',
      userId: '30001',
      noticeType: 'poke',
      text: t('poked', { who: '30001' }),
    });
    const notice = { kind: 'notice', topic: 'poke', text: '30001 poked you' };
    expect(said(live.timeline(id, base))).toEqual([notice]);
    expect(said((await (await connect()).subscribe(id)).snapshot.items)).toEqual([notice]);
    const [stored] = await host.memory.use.getHistory(id, Infinity);
    // WebUI 建的会话受众只有 owner，不带发送者前缀
    expect(stored).toMatchObject({ role: 'user', kind: 'poke', content: '[戳一戳: 30001 戳了你]' });
  });
});

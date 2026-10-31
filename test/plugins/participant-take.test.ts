import { afterEach, describe, expect, it } from 'vitest';
import { sessionDirName } from '../../packages/api-media/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { ToolCallRequest } from '../../packages/api-tools/src/index.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { answerOf, cardOf, closeParticipantApps, participantsApp } from '../fixtures/participants.js';
import { adapterPlugin, ONEBOT_TYPES } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 多人的一轮取别的会话的东西与本机文件：send_attachment 经工具调用上下文的 approveFor 逐个参与者判（真的工具注册表、
// 权限插件、会话管理与会话服务，会话管理的范围与开关取默认：同平台、读别的群、不读别人的私聊）。
// - 别的会话的：都过照常取；某个参与者自己私聊里的、别人过不了的，发一道参与者审批，只有他本人能批；都过不了照旧拒、不出卡；
// - 不属于任何会话的本机文件：owner 与别人同在时发一道参与者审批，只有 owner 过得了；没有 owner 参与的一轮取不到；
//   只有 owner 的真人一轮直接取到；群里 owner 建的定时任务取不到，owner 自己会话里的能取（保留的非人条款）。
// analyze_image、读历史的两个工具与 onebot_get_msg 经同一个 approveFor，不重复。
// ════════════════════════════════════════════════════════════

const BOT = '10000';
const G1 = `onebot:${BOT}:group:20001`;
const G2 = `onebot:${BOT}:group:20002`;
/** 群友 A 与她的私聊，第三人 B 与她的私聊，owner 与她的私聊 */
const PA = `onebot:${BOT}:private:30001`;
const PB = `onebot:${BOT}:private:30002`;
const PO = `onebot:${BOT}:private:39999`;
const A = { platform: 'onebot', userId: '30001' };
const OWNER_QQ = { platform: 'onebot', userId: '39999' };

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
/** 一个会话媒体目录里的图 */
const imageOf = (sessionId: string) => `data:/images/${sessionDirName(sessionId)}/onebot/0123456789abcdef.png`;
/** 不在任何会话媒体目录下的本机文件 */
const LOCAL = 'data:/downloads/zz-placeholder.png';
const OUT_OF_SCOPE =
  '这个文件不在这一轮能取的范围里：别的会话的媒体按这个会话的取用范围与开关；本机文件要这一轮里有 owner 的话、有别人时经她批准，或是 owner 授权的自动运行且会话里没有别人';

type Identity = { platform: string; userId: string };

afterEach(closeParticipantApps);

/** 会话媒体目录与本机文件里各放一张图；读文件头要按范围读 */
function mediaStorage(): StorageService {
  const files = new Map<string, Uint8Array>([...[G2, PA, PB].map(imageOf), LOCAL].map(uri => [uri, PNG]));
  const base = memoryStorage(files);
  return Object.assign(base, {
    readFileRange: async (uri: string, start: number, end: number) => {
      const data = files.get(uri);
      if (!data) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      return data.subarray(start, end);
    },
  });
}

/** sessionManagerConfig 是会话管理插件配置的全局层（取用范围与开关是按会话字段，全局层写在配置文档里） */
async function setup(sessionManagerConfig: Record<string, unknown> = {}) {
  const s = await participantsApp({
    config: { owners: [OWNER_QQ], plugins: { [sessionManagerPlugin.name]: sessionManagerConfig } },
    files: mediaStorage(),
    rooms: [G1, G2, PA, PB, PO],
    before: [adapterPlugin('zz-adapter-onebot', { platform: 'onebot', sessionTypes: ONEBOT_TYPES })],
    after: [imageSenderPlugin],
  });
  s.host.authority.use.setUserLevel(A, 1);
  s.host.events.use.on('outbound:message', message => {
    message.delivery = Promise.resolve({ ok: true });
  });

  /** 在 G1 里这一轮调一次 send_attachment，结果按 JSON 读 */
  const send = (participants: Identity[], target: string, extra: Partial<ToolCallRequest> = {}) =>
    s
      .execute(
        'send_attachment',
        { kind: 'image', storage_uri: target },
        { sessionId: G1, platform: 'onebot', participants, ...extra },
      )
      .then(content => JSON.parse(content) as Record<string, unknown>);
  return { ...s, send };
}

const sent = (target: string) => ({ ok: true, sent: { kind: 'image', via: 'storage_uri', ref: target } });

describe('别的会话的：逐个参与者过会话管理的规则', () => {
  it('取群友 A 自己私聊里的图：发一道参与者审批，只有 A 能批，A 批了才取到；owner 应答回 forbidden，她的 IM 私聊收不到', async () => {
    const s = await setup();
    const inRoom = s.attend(A, { window: G1 });
    const ownerChat = s.attend(OWNER_QQ, { selfId: BOT });
    const result = s.send([OWNER_QQ, A], imageOf(PA));
    const card = await cardOf(inRoom);
    expect(card.tool).toBe('send_attachment');
    expect(ownerChat.requested).toEqual([]);
    expect(s.webuiCards(), 'owner 过不了「自己的私聊」，推给她只会让审批白等').toEqual([]);
    expect(await s.conn?.fail('approval/respond', answerOf(card, 'approve'))).toMatchObject({
      data: { code: 'forbidden' },
    });
    inRoom.answer(card, 'approve');
    expect(await result).toEqual(sent(imageOf(PA)));
  });

  it('拒了只拒这一个调用', async () => {
    const s = await setup();
    const inRoom = s.attend(A, { window: G1 });
    const result = s.send([OWNER_QQ, A], imageOf(PA));
    inRoom.answer(await cardOf(inRoom), 'deny');
    expect(await result).toEqual({ error: OUT_OF_SCOPE });
    expect(await s.send([OWNER_QQ, A], imageOf(G2))).toEqual(sent(imageOf(G2)));
  });

  it('同一轮里：同平台别的群的照常取到、不出卡；第三人私聊里的直接拒、不出卡；只有 A 的一轮取他自己私聊的照常取到', async () => {
    const s = await setup();
    const inRoom = s.attend(A, { window: G1 });
    expect(await s.send([OWNER_QQ, A], imageOf(G2))).toEqual(sent(imageOf(G2)));
    expect(await s.send([OWNER_QQ, A], imageOf(PB))).toEqual({ error: OUT_OF_SCOPE });
    expect(await s.send([A], imageOf(PA))).toEqual(sent(imageOf(PA)));
    expect(inRoom.requested).toEqual([]);
    expect(s.webuiCards()).toEqual([]);
  });

  it('打开「读别人的私聊」之后取 A 私聊里的不出卡', async () => {
    const s = await setup({ takeOthersPrivate: true });
    const inRoom = s.attend(A, { window: G1 });
    expect(await s.send([OWNER_QQ, A], imageOf(PA))).toEqual(sent(imageOf(PA)));
    expect(inRoom.requested).toEqual([]);
  });
});

describe('不属于任何会话的本机文件', () => {
  it('owner 与 A 同在的一轮：发一道参与者审批，只有 owner 能批，A 应答回 forbidden；owner 批了才取到', async () => {
    const s = await setup();
    const inRoom = s.attend(A, { window: G1 });
    const ownerInRoom = s.attend(OWNER_QQ, { window: G1 });
    const result = s.send([OWNER_QQ, A], LOCAL);
    const card = await cardOf(ownerInRoom);
    expect(inRoom.requested).toEqual([]);
    expect(inRoom.answer(card, 'approve')).toMatchObject({ ok: false, refusal: 'forbidden' });
    ownerInRoom.answer(card, 'approve');
    expect(await result).toEqual(sent(LOCAL));
  });

  it('两位群友的一轮直接拒、不出卡；只有 owner 的真人一轮直接取到、不出卡', async () => {
    const s = await setup();
    const ownerInRoom = s.attend(OWNER_QQ, { window: G1 });
    expect(await s.send([A, { platform: 'onebot', userId: '30002' }], LOCAL)).toEqual({ error: OUT_OF_SCOPE });
    expect(await s.send([OWNER_QQ], LOCAL)).toEqual(sent(LOCAL));
    expect(ownerInRoom.requested).toEqual([]);
    expect(s.webuiCards()).toEqual([]);
  });

  it('群里 owner 建的定时任务那一轮取不到；owner 自己会话里的定时任务能取', async () => {
    const s = await setup();
    const scheduled = { inbound: { source: 'scheduler' } };
    expect(await s.send([OWNER_QQ], LOCAL, scheduled)).toEqual({ error: OUT_OF_SCOPE });
    expect(await s.send([OWNER_QQ], LOCAL, { ...scheduled, sessionId: PO })).toEqual(sent(LOCAL));
    expect(s.webuiCards()).toEqual([]);
  });
});

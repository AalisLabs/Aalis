import { describe, expect, it } from 'vitest';
import type { OriginKind } from '../../packages/api-approval/src/index.js';
import type { SessionInfo } from '../../packages/api-session-manager/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { originKind } from '../../packages/plugin-authority/src/authority-model.js';
import { selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { mkConfig, noFileStorage, silentLogger } from '../fixtures/authority.js';
import { storedRoom } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 发起回合的类别：按回合的来源判（inbound.source、续做的调用者、actor 有没有覆盖、会话的房间类别），
// 不按授权身份判——owner 建的定时任务会把创建者回填成 actor，按 actor 判它就成了 owner。
// 房间类别只读会话表里记下的字段（多方标记与一对一的对端），不看会话 id 的写法，也不看类型名。
// 只有 owner 与 owner-chain 能产生审批，所以每一行都是一道越权防线：它们只出在受众只有 owner 的会话（owner-only）里，
// 受众判不出的（internal）失败关闭。
// ════════════════════════════════════════════════════════════

const OWNER_QQ = '99999';
const MEMBER_QQ = '30001';
/** 另一个平台上 owner 的身份：这个平台声明 thread（多方）与 dm（一对一） */
const OWNER_FORUM = 'f-owner';
const isOwner = (platform: string, userId?: string) =>
  ((platform === 'webui' || platform === 'cli') && userId === 'console') ||
  (platform === 'onebot' && userId === OWNER_QQ) ||
  (platform === 'forum' && userId === OWNER_FORUM);

const OWNER = { platform: 'webui', userId: 'console' };
const WEBUI = 'session-a1b2c3d4';
const GROUP = 'onebot:10000:group:20001';
const OWNER_DM = `onebot:10000:private:${OWNER_QQ}`;
const MEMBER_DM = `onebot:10000:private:${MEMBER_QQ}`;
const OWNER_NUMBER_GROUP = `onebot:10000:group:${OWNER_QQ}`;
/** 按 id 兜底建档的群（子任务兜底、/session.set）：没有来源字段与创建来源 */
const FALLBACK_GROUP = 'onebot:10000:group:20002';
/** forum 的会话 id 由它的适配器自定：类型名不叫 group、private，id 也不按 onebot 的写法 */
const THREAD = 'forum-thread-t1';
const OWNER_FORUM_DM = `forum:bot:dm:${OWNER_FORUM}`;
const MEMBER_FORUM_DM = 'forum:bot:dm:f-member';

const record = (id: string, fields: Partial<SessionInfo>) =>
  ({ id, name: id, children: [], status: 'waiting', config: {}, createdAt: 0, updatedAt: 0, ...fields }) as SessionInfo;
const forumRoom = (id: string, type: string, multiParty: boolean, targetId: string) =>
  record(id, { originPlatform: 'forum', originChat: { type, multiParty, targetId } });

/** 会话表：WebUI 与终端的会话带创建来源，IM 房间带建档时记下的来源字段；workflow::daily、tg-1、tg-2 不在表里 */
const table = new Map<string, SessionInfo>(
  [
    record(WEBUI, { createdFrom: 'webui' }),
    record('cli-default', { createdFrom: 'cli' }),
    record(FALLBACK_GROUP, {}),
    ...[GROUP, OWNER_DM, MEMBER_DM, OWNER_NUMBER_GROUP].map(id => storedRoom(id) as unknown as SessionInfo),
    forumRoom(THREAD, 'thread', true, 't1'),
    forumRoom(OWNER_FORUM_DM, 'dm', false, OWNER_FORUM),
    forumRoom(MEMBER_FORUM_DM, 'dm', false, 'f-member'),
    record(`${WEBUI}::abcd1234`, { parentId: WEBUI }),
    record(`${GROUP}::abcd1234`, { parentId: GROUP }),
  ].map(s => [s.id, s]),
);
const lookup = (id: string) => table.get(id);

type Turn = Parameters<typeof originKind>[0];

const rows: Array<[string, Turn, OriginKind]> = [
  ['owner 在 WebUI 亲手发来', { sessionId: WEBUI, ...OWNER, inbound: {} }, 'owner'],
  ['owner 在终端亲手发来', { sessionId: 'cli-default', platform: 'cli', userId: 'console', inbound: {} }, 'owner'],
  [
    'owner 在自己的 QQ 私聊亲手发来',
    { sessionId: OWNER_DM, platform: 'onebot', userId: OWNER_QQ, inbound: {} },
    'owner',
  ],
  [
    'owner 会话里后台任务结束后的续做',
    { sessionId: WEBUI, ...OWNER, actor: OWNER, inbound: { source: 'bg:bg_x_1', callerUserId: 'console' } },
    'owner-chain',
  ],
  [
    '续做的那次调用不是 owner 发起的（子任务里转后台的调用）',
    {
      sessionId: `${WEBUI}::abcd1234`,
      platform: 'webui',
      userId: `parent:${WEBUI}`,
      actor: OWNER,
      inbound: { source: 'bg:bg_x_2', callerUserId: `parent:${WEBUI}` },
    },
    'other',
  ],
  [
    '续做的调用者是 owner、授权身份却不是（自发的一轮里转后台的调用）',
    {
      sessionId: WEBUI,
      ...OWNER,
      actor: selfInitiatedActor('webui'),
      inbound: { source: 'bg:bg_x_3', callerUserId: 'console' },
    },
    'other',
  ],
  [
    'owner 建的定时任务（创建者回填成授权身份）',
    { sessionId: WEBUI, platform: 'webui', actor: OWNER, inbound: { source: 'scheduler' } },
    'autonomous',
  ],
  [
    '定时任务触发的编排：agent 节点的一轮',
    { sessionId: WEBUI, platform: 'webui', actor: OWNER, inbound: { source: 'workflow:daily:summarize' } },
    'autonomous',
  ],
  [
    '编排的工具节点：不在入站回合里',
    { sessionId: 'workflow::daily', platform: 'workflow', actor: OWNER },
    'autonomous',
  ],
  ['空闲触发', { sessionId: WEBUI, platform: 'webui', inbound: { source: 'idle-trigger' } }, 'autonomous'],
  [
    '不延续调用的宿主通知（白纸任务）',
    { sessionId: WEBUI, platform: 'webui', actor: selfInitiatedActor('webui'), inbound: { source: 'paper:p1:t1' } },
    'autonomous',
  ],
  [
    '频率触发把这一轮记成自发的（owner 恰好是最后发言者）',
    { sessionId: WEBUI, ...OWNER, actor: selfInitiatedActor('webui'), inbound: {} },
    'autonomous',
  ],
  ['群房间里 owner 亲手发来', { sessionId: GROUP, platform: 'onebot', userId: OWNER_QQ, inbound: {} }, 'room'],
  ['群房间里群成员发来', { sessionId: GROUP, platform: 'onebot', userId: MEMBER_QQ, inbound: {} }, 'room'],
  [
    '群号恰好与 owner 的 QQ 号相同的群房间',
    { sessionId: OWNER_NUMBER_GROUP, platform: 'onebot', userId: OWNER_QQ, inbound: {} },
    'room',
  ],
  ['owner 在 WebUI 驱动群房间', { sessionId: GROUP, ...OWNER, inbound: {} }, 'room'],
  ['owner 在 WebUI 驱动对端不是 owner 的私聊', { sessionId: MEMBER_DM, ...OWNER, inbound: {} }, 'room'],
  ['对端不是 owner 的私聊', { sessionId: MEMBER_DM, platform: 'onebot', userId: MEMBER_QQ, inbound: {} }, 'room'],
  [
    '群房间里的定时任务',
    {
      sessionId: GROUP,
      platform: 'onebot',
      actor: { platform: 'onebot', userId: OWNER_QQ },
      inbound: { source: 'scheduler' },
    },
    'room',
  ],
  [
    '子任务回合',
    {
      sessionId: `${WEBUI}::abcd1234`,
      platform: 'webui',
      userId: `parent:${WEBUI}`,
      actor: OWNER,
      inbound: { source: 'subtask' },
    },
    'subtask',
  ],
  [
    '房间里的子任务回合',
    { sessionId: `${GROUP}::abcd1234`, platform: 'onebot', userId: `parent:${GROUP}`, inbound: { source: 'subtask' } },
    'subtask',
  ],
  ['其他用户在不是房间的会话里亲手发来', { sessionId: 'tg-1', platform: 'test', userId: 'u1', inbound: {} }, 'other'],
  [
    '按 id 兜底建档的群（受众判不出）里 owner 亲手发来',
    { sessionId: FALLBACK_GROUP, platform: 'onebot', userId: OWNER_QQ, inbound: {} },
    'other',
  ],
  [
    '按 id 兜底建档的群里 owner 的续做',
    {
      sessionId: FALLBACK_GROUP,
      platform: 'onebot',
      userId: OWNER_QQ,
      actor: { platform: 'onebot', userId: OWNER_QQ },
      inbound: { source: 'bg:bg_x_5', callerUserId: OWNER_QQ },
    },
    'other',
  ],
  ['会话表里没有的会话（会话管理不在）里 owner 亲手发来', { sessionId: 'tg-2', ...OWNER, inbound: {} }, 'other'],
  [
    '群房间的子会话里 owner 的续做：按根会话的房间类别',
    {
      sessionId: `${GROUP}::abcd1234`,
      platform: 'onebot',
      userId: OWNER_QQ,
      actor: { platform: 'onebot', userId: OWNER_QQ },
      inbound: { source: 'bg:bg_x_4', callerUserId: OWNER_QQ },
    },
    'room',
  ],
  [
    '多方的 thread 窗口里 owner 亲手发来（类型名不叫 group，id 也不带平台前缀）',
    { sessionId: THREAD, platform: 'forum', userId: OWNER_FORUM, inbound: {} },
    'room',
  ],
  [
    '一对一的 dm 窗口、对端是 owner：owner 亲手发来（类型名不叫 private）',
    { sessionId: OWNER_FORUM_DM, platform: 'forum', userId: OWNER_FORUM, inbound: {} },
    'owner',
  ],
  [
    '一对一的 dm 窗口、对端不是 owner',
    { sessionId: MEMBER_FORUM_DM, platform: 'forum', userId: 'f-member', inbound: {} },
    'room',
  ],
];

describe('发起回合的类别', () => {
  it.each(rows)('%s', (_label, turn, kind) => {
    expect(originKind(turn, isOwner, lookup)).toBe(kind);
  });
});

describe('权限服务的 originOf', () => {
  // 判据就是 originKind：owner 取宿主配置的 owners（本机控制台恒为 owner），会话按构造时给的会话表取
  const manager = new AuthorityManager(
    mkConfig({
      owners: [
        { platform: 'onebot', userId: OWNER_QQ },
        { platform: 'forum', userId: OWNER_FORUM },
      ],
    }),
    silentLogger(),
    noFileStorage,
    lookup,
  );

  it.each(rows)('%s', (_label, turn, kind) => {
    expect(manager.originOf(turn)).toBe(kind);
  });
});

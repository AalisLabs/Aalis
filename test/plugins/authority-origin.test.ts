import { describe, expect, it } from 'vitest';
import type { OriginKind } from '../../packages/api-approval/src/index.js';
import { originKind } from '../../packages/plugin-authority/src/authority-model.js';
import { selfInitiatedActor } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 发起回合的类别：按回合的来源判（inbound.source、续做的调用者、actor 有没有覆盖、会话受众），
// 不按授权身份判——owner 建的定时任务会把创建者回填成 actor，按 actor 判它就成了 owner。
// 只有 owner 与 owner-chain 能产生审批，所以每一行都是一道越权防线。
// ════════════════════════════════════════════════════════════

const OWNER_QQ = '99999';
const MEMBER_QQ = '30001';
const isOwner = (platform: string, userId?: string) =>
  ((platform === 'webui' || platform === 'cli') && userId === 'console') ||
  (platform === 'onebot' && userId === OWNER_QQ);

const OWNER = { platform: 'webui', userId: 'console' };
const WEBUI = 'session-a1b2c3d4';
const GROUP = 'onebot:10000:group:20001';
const OWNER_DM = `onebot:10000:private:${OWNER_QQ}`;
const MEMBER_DM = `onebot:10000:private:${MEMBER_QQ}`;

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
    { sessionId: `onebot:10000:group:${OWNER_QQ}`, platform: 'onebot', userId: OWNER_QQ, inbound: {} },
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
];

describe('发起回合的类别', () => {
  it.each(rows)('%s', (_label, turn, kind) => {
    expect(originKind(turn, isOwner)).toBe(kind);
  });
});

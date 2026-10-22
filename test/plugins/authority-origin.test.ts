import { describe, expect, it } from 'vitest';
import type { OriginKind } from '../../packages/api-approval/src/index.js';
import type { OriginTurn } from '../../packages/api-authority/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { type FromTurn, selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { mkConfig, noFileStorage, silentLogger } from '../fixtures/authority.js';

// ════════════════════════════════════════════════════════════
// 发起回合的类别：按这一轮从哪里来判，不看会话类型与受众，也不判是不是 owner。
// - 人亲手发来的消息（不带来源，含群里没点名、被频率触发挑中的插话）为 hand，不论在哪个会话、是谁；
// - 子任务回合为 subtask；
// - 续做（带起它的那一轮 fromTurn）与它延续的那一轮同一类别；
// - 其余注入与不在入站回合里的调用为 autonomous：按授权身份判会把 owner 建的定时任务当成 owner 亲手。
// 是不是 owner 由用到类别的地方（审批服务等）按身份判，所以类别对 owner 与群成员一样。
// ════════════════════════════════════════════════════════════

const OWNER_QQ = '99999';
const OWNER = { platform: 'webui', userId: 'console' };
const OWNER_ON_QQ = { platform: 'onebot', userId: OWNER_QQ };
const MEMBER = { platform: 'onebot', userId: '30001' };
const WEBUI = 'session-a1b2c3d4';
const GROUP = 'onebot:10000:group:20001';
const OWNER_DM = `onebot:10000:private:${OWNER_QQ}`;

/** 起它的那一轮：人亲手发来的 */
const handTurn = (who: { platform: string; userId: string }): FromTurn => ({
  platform: who.platform,
  userId: who.userId,
  participants: [who],
});

/** 续做那一轮：工具眼里是起它的人在调，授权身份取起它的那一轮的参与者 */
const resumed = (sessionId: string, from: FromTurn): OriginTurn => ({
  sessionId,
  platform: from.platform,
  userId: from.userId,
  actor: from.participants[0],
  inbound: { source: 'bg:bg_x_1', fromTurn: from },
});

const rows: Array<[string, OriginTurn, OriginKind]> = [
  ['owner 在 WebUI 亲手发来', { sessionId: WEBUI, ...OWNER, inbound: {} }, 'hand'],
  ['owner 在群里点名她，或没点名而被频率触发挑中：不看会话', { sessionId: GROUP, ...OWNER_ON_QQ, inbound: {} }, 'hand'],
  ['群成员在群里发来：不判是不是 owner', { sessionId: GROUP, ...MEMBER, inbound: {} }, 'hand'],
  [
    '没有人的消息（授权身份没有账号）：她自己开口',
    { sessionId: WEBUI, ...OWNER, actor: selfInitiatedActor('webui'), inbound: {} },
    'autonomous',
  ],
  [
    'owner 建的定时任务（创建者回填成授权身份）',
    { sessionId: WEBUI, platform: 'webui', actor: OWNER, inbound: { source: 'scheduler' } },
    'autonomous',
  ],
  [
    '编排的工具节点：不在入站回合里',
    { sessionId: 'workflow::daily', platform: 'workflow', actor: OWNER },
    'autonomous',
  ],
  ['续做：owner 在群里亲手那一轮起的', resumed(GROUP, handTurn(OWNER_ON_QQ)), 'hand'],
  [
    '续做：平台请求事件那一轮起的（申请人是 owner，不按身份推成她亲手）',
    resumed(OWNER_DM, {
      platform: 'onebot',
      userId: OWNER_QQ,
      participants: [OWNER_ON_QQ],
      source: 'onebot-request',
    }),
    'autonomous',
  ],
  [
    '续做：子任务回合里起的',
    resumed(`${WEBUI}::abcd1234`, {
      platform: 'webui',
      userId: `parent:${WEBUI}`,
      participants: [OWNER],
      source: 'subtask',
    }),
    'subtask',
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
];

describe('权限服务的 originOf', () => {
  // 判据是 authority-model 的 originKind：不读会话记录，权限服务不用会话管理
  const manager = new AuthorityManager(mkConfig({ owners: [OWNER_ON_QQ] }), silentLogger(), noFileStorage);

  it.each(rows)('%s', (_label, turn, kind) => {
    expect(manager.originOf(turn)).toBe(kind);
  });
});

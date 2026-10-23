import { describe, expect, it } from 'vitest';
import type { OriginKind } from '../../packages/api-approval/src/index.js';
import { type OriginTurn, originTurnOf } from '../../packages/api-authority/src/index.js';
import { markTriggered } from '../../packages/api-trigger/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { originKind } from '../../packages/plugin-authority/src/authority-model.js';
import { type FromTurn, type IncomingMessage, selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { mkConfig, noFileStorage, silentLogger } from '../fixtures/authority.js';

// ════════════════════════════════════════════════════════════
// 发起回合的类别：按这一轮从哪里来判，不看会话类型与受众，也不判是不是 owner。
// - 人亲手发来的消息（不带来源，含群里没点名、被频率触发挑中的插话）为 hand，不论在哪个会话、是谁；
// - 子任务回合为 subtask；
// - 续做（带起它的那一轮 fromTurn）与它延续的那一轮同一类别；几个人的一轮同样按这几条判；
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
  participants: from.participants,
  inbound: { source: 'bg:bg_x_1', fromTurn: from },
});

const rows: Array<[string, OriginTurn, OriginKind]> = [
  ['owner 在 WebUI 亲手发来', { sessionId: WEBUI, ...OWNER, participants: [OWNER], inbound: {} }, 'hand'],
  [
    'owner 在群里点名她，或没点名而被频率触发挑中：不看会话',
    { sessionId: GROUP, ...OWNER_ON_QQ, participants: [OWNER_ON_QQ], inbound: {} },
    'hand',
  ],
  ['群成员在群里发来：不判是不是 owner', { sessionId: GROUP, ...MEMBER, participants: [MEMBER], inbound: {} }, 'hand'],
  [
    '没有人的消息（授权身份没有账号）：她自己开口',
    { sessionId: WEBUI, ...OWNER, participants: [selfInitiatedActor('webui')], inbound: {} },
    'autonomous',
  ],
  [
    'owner 建的定时任务（创建者回填成授权身份）',
    { sessionId: WEBUI, platform: 'webui', participants: [OWNER], inbound: { source: 'scheduler' } },
    'autonomous',
  ],
  [
    '编排的工具节点：不在入站回合里',
    { sessionId: 'workflow::daily', platform: 'workflow', participants: [OWNER] },
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
      participants: [OWNER],
      inbound: { source: 'subtask' },
    },
    'subtask',
  ],
  [
    '几个人的一轮：owner 点名开轮、群成员的话叠进来',
    { sessionId: GROUP, platform: 'onebot', participants: [OWNER_ON_QQ, MEMBER], inbound: {} },
    'hand',
  ],
  ['几个人的一轮的续做', resumed(GROUP, { platform: 'onebot', participants: [OWNER_ON_QQ, MEMBER] }), 'hand'],
];

describe('权限服务的 originOf', () => {
  // 判据是 authority-model 的 originKind：不读会话记录，权限服务不用会话管理
  const manager = new AuthorityManager(mkConfig({ owners: [OWNER_ON_QQ] }), silentLogger(), noFileStorage);

  it.each(rows)('%s', (_label, turn, kind) => {
    expect(manager.originOf(turn)).toBe(kind);
  });

  it('类别只看消息事实，不收 isOwner', () => {
    const turn: OriginTurn = { sessionId: GROUP, ...MEMBER, participants: [MEMBER], inbound: {} };
    // @ts-expect-error originKind 只收这一轮，不收判 owner 的函数
    expect(originKind(turn, () => true)).toBe('hand');
  });
});

// ════════════════════════════════════════════════════════════
// 这一轮的主体：人亲手那一轮（含它的续做）的参与者是 owner 即 owner；子任务随派它的那一轮（任务消息带着的 fromTurn），
// 不按子任务回合自己的授权身份；其余（自主回合、没带 fromTurn 的子任务）为 other。
// ════════════════════════════════════════════════════════════

/** 子任务回合：发言者记作父会话，授权身份取派它的那一轮的参与者 */
const subtaskOf = (parent: string, from: FromTurn): OriginTurn => ({
  sessionId: `${parent}::abcd1234`,
  platform: from.platform,
  userId: `parent:${parent}`,
  participants: from.participants,
  inbound: { source: 'subtask', fromTurn: from },
});

/** 那一轮里转后台的调用的续做那一轮的事实 */
const resumedFacts = (from: FromTurn): FromTurn => ({
  platform: from.platform,
  userId: from.userId,
  participants: from.participants,
  source: 'bg:bg_x_1',
  fromTurn: from,
});

/** 子任务那一轮的事实：派它的是 from 那一轮 */
const subtaskFacts = (parent: string, from: FromTurn): FromTurn => ({
  platform: from.platform,
  userId: `parent:${parent}`,
  participants: from.participants,
  source: 'subtask',
  fromTurn: from,
});

/** 定时任务那一轮的事实：授权身份是创建者 owner */
const SCHEDULED: FromTurn = { platform: 'webui', participants: [OWNER], source: 'scheduler' };
const CHILD = `${WEBUI}::abcd1234`;

const principals: Array<[string, OriginTurn, 'owner' | 'other']> = [
  ['owner 在群里亲手发来', { sessionId: GROUP, ...OWNER_ON_QQ, participants: [OWNER_ON_QQ], inbound: {} }, 'owner'],
  ['owner 在 WebUI 亲手发来', { sessionId: WEBUI, ...OWNER, participants: [OWNER], inbound: {} }, 'owner'],
  ['群成员在群里亲手发来', { sessionId: GROUP, ...MEMBER, participants: [MEMBER], inbound: {} }, 'other'],
  ['owner 那一轮的续做', resumed(GROUP, handTurn(OWNER_ON_QQ)), 'owner'],
  ['群成员那一轮的续做', resumed(GROUP, handTurn(MEMBER)), 'other'],
  ['子任务：派自 owner 亲手那一轮', subtaskOf(GROUP, handTurn(OWNER_ON_QQ)), 'owner'],
  ['子任务：派自 owner 那一轮的续做', subtaskOf(GROUP, resumedFacts(handTurn(OWNER_ON_QQ))), 'owner'],
  ['子任务：派自群成员那一轮', subtaskOf(GROUP, handTurn(MEMBER)), 'other'],
  ['子任务：派自定时任务那一轮（授权身份是 owner）', subtaskOf(WEBUI, SCHEDULED), 'other'],
  [
    '子任务里转后台的调用的续做：派子任务的是 owner 亲手那一轮',
    resumed(CHILD, subtaskFacts(WEBUI, handTurn(OWNER))),
    'owner',
  ],
  ['子任务里转后台的调用的续做：派子任务的是定时任务那一轮', resumed(CHILD, subtaskFacts(WEBUI, SCHEDULED)), 'other'],
  [
    '没带起它的那一轮的子任务（授权身份是 owner）',
    {
      sessionId: CHILD,
      platform: 'webui',
      userId: `parent:${WEBUI}`,
      participants: [OWNER],
      inbound: { source: 'subtask' },
    },
    'other',
  ],
  [
    'owner 与群成员同在的一轮',
    { sessionId: GROUP, platform: 'onebot', participants: [OWNER_ON_QQ, MEMBER], inbound: {} },
    'other',
  ],
  [
    '参与者都是 owner（她的两个身份）',
    { sessionId: GROUP, platform: 'onebot', participants: [OWNER, OWNER_ON_QQ], inbound: {} },
    'owner',
  ],
  ['owner 与群成员那一轮的续做', resumed(GROUP, { platform: 'onebot', participants: [OWNER_ON_QQ, MEMBER] }), 'other'],
  [
    '子任务：派自 owner 与群成员那一轮',
    subtaskOf(GROUP, { platform: 'onebot', participants: [OWNER_ON_QQ, MEMBER] }),
    'other',
  ],
  [
    '自主回合：owner 建的定时任务',
    { sessionId: WEBUI, platform: 'webui', participants: [OWNER], inbound: { source: 'scheduler' } },
    'other',
  ],
];

describe('权限服务的 principalOf', () => {
  const manager = new AuthorityManager(mkConfig({ owners: [OWNER_ON_QQ] }), silentLogger(), noFileStorage);

  it.each(principals)('%s', (_label, turn, principal) => {
    expect(manager.principalOf(turn)).toBe(principal);
  });
});

// ════════════════════════════════════════════════════════════
// 一轮的参与者：已经送进模型的每条输入的授权身份（actor ?? 发言者，没有发言者的是无主体），按身份去重、按进入先后排；
// owner 的各个身份算一个参与者（取最先进来的那一个，判 owner 用调用方给的 isOwner，不给时按字面身份）；带起它的那一轮的
// 取它的参与者。点名只决定她回不回，插话照样按说话的人算，不看 triggerType。
// ════════════════════════════════════════════════════════════

describe('originTurnOf 交出的参与者', () => {
  const isOwner = (platform: string, userId: string) =>
    (platform === OWNER.platform && userId === OWNER.userId) ||
    (platform === OWNER_ON_QQ.platform && userId === OWNER_ON_QQ.userId);
  const OTHER = { platform: 'onebot', userId: '30002' };
  /** 群里的一句：triggerType 给了即经触发器放行（immediate 是点名，interval 是被频率触发挑中的插话） */
  const said = (
    who: { platform: string; userId: string },
    triggerType?: 'immediate' | 'interval',
    extra: Partial<IncomingMessage> = {},
  ): IncomingMessage => {
    const message: IncomingMessage = { content: '<一句>', sessionId: GROUP, ...who, sessionType: 'group', ...extra };
    if (triggerType) markTriggered(message, triggerType === 'immediate');
    return message;
  };

  it('点名的一句与两位群友没点名的两句：参与者是三位发言者本人', () => {
    const turn = originTurnOf(
      [said(MEMBER, 'immediate'), said(OTHER, 'interval'), said(OWNER_ON_QQ, 'interval')],
      isOwner,
    );
    expect(turn.participants).toEqual([MEMBER, OTHER, OWNER_ON_QQ]);
  });

  it('owner 点名的一句与她自己没点名的一句：参与者只有她', () => {
    expect(originTurnOf([said(OWNER_ON_QQ, 'immediate'), said(OWNER_ON_QQ, 'interval')], isOwner).participants).toEqual(
      [OWNER_ON_QQ],
    );
  });

  it.each(['immediate', 'interval'] as const)('全是插话（%s 改成别的值结果不变）：参与者是那几位发言者', type => {
    expect(
      originTurnOf([said(MEMBER, 'interval'), said(OTHER, type), said(MEMBER, type)], isOwner).participants,
    ).toEqual([MEMBER, OTHER]);
  });

  it('owner 引用或转发群友的消息再点名她：引用转发进她这条输入的内容算她的', () => {
    const quoting = said(OWNER_ON_QQ, 'immediate', {
      replyTo: { messageId: 'm1', userId: MEMBER.userId, content: '<被引用的话>' },
    });
    expect(originTurnOf([quoting], isOwner).participants).toEqual([OWNER_ON_QQ]);
  });

  it('owner 的两个身份合成一个，取最先进来的那一个；权限服务不在时按字面身份', () => {
    const inputs: [IncomingMessage, ...IncomingMessage[]] = [
      { content: '<一句>', sessionId: GROUP, ...OWNER },
      said(OWNER_ON_QQ, 'immediate'),
    ];
    expect(originTurnOf(inputs, isOwner).participants).toEqual([OWNER]);
    expect(originTurnOf(inputs).participants).toEqual([OWNER, OWNER_ON_QQ]);
  });

  it('带起它的那一轮的注入取它的参与者；没有发言者的是无主体', () => {
    const from: FromTurn = { platform: 'onebot', participants: [OWNER_ON_QQ, MEMBER] };
    expect(
      originTurnOf([{ content: '<通知>', sessionId: GROUP, platform: 'onebot', source: 'bg:bg_x_1', fromTurn: from }])
        .participants,
    ).toEqual([OWNER_ON_QQ, MEMBER]);
    expect(
      originTurnOf([{ content: '<开话题>', sessionId: GROUP, platform: 'onebot', source: 'idle-trigger' }])
        .participants,
    ).toEqual([{ platform: 'onebot', userId: '' }]);
  });

  it('发言者：各条输入的发言者相同时是他，不同时没有；入站回合的消息 id 取最近一条输入的', () => {
    const same = originTurnOf([
      said(MEMBER, 'immediate', { messageId: 'm1' }),
      said(MEMBER, 'interval', { messageId: 'm2' }),
    ]);
    expect(same.userId).toBe(MEMBER.userId);
    expect(same.inbound?.messageId).toBe('m2');
    expect(originTurnOf([said(MEMBER, 'immediate'), said(OTHER, 'interval')]).userId).toBeUndefined();
  });
});

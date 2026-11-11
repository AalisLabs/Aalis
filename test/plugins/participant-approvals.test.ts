import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Verdict } from '../../packages/api-authority/src/index.js';
import type { ToolCallContext, ToolCallRequest } from '../../packages/api-tools/src/index.js';
import type { FromTurn, IncomingMessage } from '../../packages/schema-message/src/index.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { answerOf, cardOf, closeParticipantApps, participantsApp } from '../fixtures/participants.js';

// ════════════════════════════════════════════════════════════
// 多人的一轮：执行守卫对每个参与者各裁决一次（真的工具注册表、权限插件与会话服务）。
// - 都能做照常执行；有人做不了的这一个调用要一道参与者审批，凡自己就能做的人都能批；都做不了照旧拒；
// - 要 owner 确认的与参与者审批合成一张，只有 owner 能批；
// - 审批服务一条覆盖规则：能批且接入覆盖这张才推、才算在场、才认应答。WebUI 不限；owner 的 IM 私聊只收只有 owner 能批的；
//   群窗口只收这个窗口发起的、不是只有 owner 能批的；
// - 批过的调用按批的人执行：交给处理函数与转后台登记的上下文里参与者换成他（他是参与者之一时取那个参与者的身份）；
// - 取用判定（approveFor）按同一条三分；可转后台的工具等审批时不转后台，转到后台之后只按参与者都过判。
// 非 owner 的应答面经测试的审批面接入限定窗口（`attend(who, sink, { window })`）；owner 的 WebUI 是一条在场的会话协议连接。
// ════════════════════════════════════════════════════════════

const BOT = '10000';
const ROOM = `onebot:${BOT}:group:20001`;
const OTHER_ROOM = `onebot:${BOT}:group:20002`;
const OWNER = { platform: 'webui', userId: 'console' };
const OWNER_QQ = { platform: 'onebot', userId: '99999' };
/** 0 级、1 级群友，不在这一轮里的 1 级群友，封禁的群友 */
const L0 = { platform: 'onebot', userId: '30000' };
const L1 = { platform: 'onebot', userId: '30001' };
const L1_ELSEWHERE = { platform: 'onebot', userId: '30002' };
const BANNED = { platform: 'onebot', userId: '30003' };

/** 门槛 1、可转后台的探针；声明了确认的探针；处理函数里调 approveFor 的探针与它可转后台的一份 */
const SENSITIVE = 'zz_sensitive_probe';
const CONFIRM = 'zz_confirm_probe';
const TAKE = 'zz_take_probe';
const BG_TAKE = 'zz_bg_take_probe';

const NOBODY = '这一轮的参与者里没有人能做这件事';
const INELIGIBLE = '这一轮里没有 owner 的话，要 owner 确认的操作不能执行';

type Identity = { platform: string; userId: string };

afterEach(closeParticipantApps);

async function setup({ appConfig = {}, webui = true }: { appConfig?: Record<string, unknown>; webui?: boolean } = {}) {
  const s = await participantsApp({
    config: { owners: [OWNER_QQ], ...appConfig },
    files: memoryStorage(new Map()),
    rooms: [ROOM, OTHER_ROOM],
    webui,
  });
  const { host } = s;
  const levels = host.authority.use;
  levels.setUserLevel(L1, 1);
  levels.setUserLevel(L1_ELSEWHERE, 1);
  levels.setUserLevel(BANNED, -1);

  /** 处理函数每次拿到的上下文 */
  const seen: ToolCallContext[] = [];
  /** 取用探针每次的结果 */
  const outcomes: string[] = [];
  /** 取用探针的判定：按身份判，用例改它；判完之后等 gate 才落定 */
  let check: (who: Identity) => Verdict = () => ({ ok: true });
  let gate: Promise<void> = Promise.resolve();
  const probe = (name: string, extra: Record<string, unknown>, handler?: (ctx: ToolCallContext) => Promise<string>) =>
    host.tools.use.register({
      ...extra,
      definition: {
        type: 'function',
        function: {
          name,
          description: '探针',
          parameters: { type: 'object', properties: { what: { type: 'string' } } },
        },
      },
      handler: async (_args, ctx) => {
        seen.push(ctx);
        return handler ? handler(ctx) : 'ran';
      },
    });
  const take = async (ctx: ToolCallContext) => {
    const verdict = await ctx.approveFor(who => check(who));
    await gate;
    const outcome = verdict.ok ? 'taken' : `refused: ${String(verdict.reason)}`;
    outcomes.push(outcome);
    return outcome;
  };
  probe(SENSITIVE, { risk: 'sensitive', background: {} });
  probe(CONFIRM, { confirm: 'session' });
  probe(TAKE, {}, take);
  const withdrawBgTake = probe(BG_TAKE, { background: {} }, take);

  // 结束通知：转到后台的调用结束时注入的宿主通知
  const notices: IncomingMessage[] = [];
  host.events.use.on('inbound:message', message => {
    if (message.source?.startsWith('bg:')) notices.push(message);
  });

  /** 按 agent 工具循环的填法在 ROOM 里调一次 */
  const call = (
    participants: Identity[],
    name = SENSITIVE,
    args: Record<string, unknown> = {},
    extra: Partial<ToolCallRequest> = {},
  ) => s.execute(name, args, { sessionId: ROOM, platform: 'onebot', participants, ...extra });
  const answerOnWebui = (...answer: Parameters<typeof answerOf>) =>
    s.conn?.call('approval/respond', answerOf(...answer));
  return {
    ...s,
    call,
    seen,
    outcomes,
    notices,
    answerOnWebui,
    withdrawBgTake,
    setCheck(next: (who: Identity) => Verdict) {
      check = next;
    },
    /** 取用探针判完之后等到 release 才落定 */
    holdTake() {
      let release = () => {};
      gate = new Promise(resolve => {
        release = resolve;
      });
      return release;
    },
  };
}

describe('执行守卫按每个参与者裁决', () => {
  it('都能做：两位 1 级群友调门槛 1 的工具，照常执行，不产生审批', async () => {
    const s = await setup();
    const window = s.attend(L1_ELSEWHERE, { window: ROOM });
    expect(await s.call([L1, L1_ELSEWHERE])).toBe('ran');
    expect(s.webuiCards()).toEqual([]);
    expect(window.requested).toEqual([]);
  });

  it('有人做不了：owner 与 0 级群友的一轮出一张参与者审批，推给 WebUI 与这个窗口里能批的人，不推给 owner 的 IM 私聊', async () => {
    const s = await setup();
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    const zero = s.attend(L0, { window: ROOM });
    const otherRoom = s.attend(L1, { window: OTHER_ROOM });
    const ownerChat = s.attend(OWNER_QQ, { selfId: BOT });
    const result = s.call([OWNER_QQ, L0]);
    const card = await cardOf(elsewhere);
    expect(card.origin).toEqual({ kind: 'hand', participants: [OWNER_QQ, L0] });
    await vi.waitFor(() => expect(s.webuiCards()).toHaveLength(1));
    expect(zero.requested, '0 级群友自己做不了，推给他只会让审批空等').toEqual([]);
    expect(otherRoom.requested).toEqual([]);
    expect(ownerChat.requested, 'owner 的 IM 私聊只收只有她能批的').toEqual([]);
    expect(zero.answer(card, 'approve')).toMatchObject({ ok: false, refusal: 'forbidden' });
    expect(otherRoom.answer(card, 'approve')).toMatchObject({ ok: false, refusal: 'not-found' });
    expect(s.seen, '批准之前不得执行').toEqual([]);
    expect(elsewhere.answer(card, 'approve')).toEqual({ ok: true });
    expect(await result).toBe('ran');
    expect(s.seen[0].participants, '批过的调用按批的人执行').toEqual([L1_ELSEWHERE]);
    expect(s.conn?.notifications('approval/settled'), 'WebUI 的结算写明是谁批的、不是 owner').toEqual([
      expect.objectContaining({ state: 'approved', source: 'answer', by: { ...L1_ELSEWHERE, owner: false } }),
    ]);
  });

  it('批的人接着往下：转到后台的调用，结束通知带着的那一轮只有批的人', async () => {
    const s = await setup();
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    const result = s.call([OWNER_QQ, L0], SENSITIVE, { runInBackground: true });
    elsewhere.answer(await cardOf(elsewhere), 'approve');
    expect(await result).toContain('taskId');
    await vi.waitFor(() => expect(s.notices).toHaveLength(1));
    expect((s.notices[0].fromTurn as FromTurn).participants).toEqual([L1_ELSEWHERE]);
  });

  it('owner 在 WebUI 批：按这一轮里她的身份往下，结算写明是她批的', async () => {
    const s = await setup();
    const result = s.call([OWNER_QQ, L0]);
    await vi.waitFor(() => expect(s.webuiCards()).toHaveLength(1));
    await s.answerOnWebui(s.webuiCards()[0], 'approve');
    expect(await result).toBe('ran');
    expect(s.seen[0].participants).toEqual([OWNER_QQ]);
    expect(s.conn?.notifications('approval/settled')).toEqual([
      expect.objectContaining({ state: 'approved', source: 'answer', by: { ...OWNER, owner: true } }),
    ]);
  });

  it('拒绝只拒这一个调用：拒绝语不指名 owner，同一批的下一个调用照常判', async () => {
    const s = await setup();
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    const first = s.call([OWNER_QQ, L0]);
    elsewhere.answer(await cardOf(elsewhere), 'deny', '先别动');
    const out = await first;
    expect(out).toContain('被拒绝了，说明：「先别动」');
    expect(out).not.toContain('owner');
    const second = s.call([OWNER_QQ, L0]);
    elsewhere.answer(await cardOf(elsewhere, 2), 'approve');
    expect(await second).toBe('ran');
  });

  it('过期只拒这一个调用：拒绝语不指名 owner，同一批的下一个调用照常判', async () => {
    const s = await setup();
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const first = s.call([OWNER_QQ, L0]);
      await cardOf(elsewhere);
      await vi.advanceTimersByTimeAsync(300_000);
      const out = await first;
      expect(out).toContain('等了 300 秒没有人应答');
      expect(out).not.toContain('owner');
      const second = s.call([OWNER_QQ, L0]);
      elsewhere.answer(await cardOf(elsewhere, 2), 'approve');
      expect(await second).toBe('ran');
    } finally {
      vi.useRealTimers();
    }
  });

  it('都做不了：两位 0 级群友照旧直接拒，不产生审批；只有一位时是等级裁决原来的拒绝语', async () => {
    const s = await setup();
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    const two = await s.call([L0, { platform: 'onebot', userId: '30009' }]);
    expect(two).toContain(NOBODY);
    expect(await s.call([L0])).toContain('权限不足');
    expect(elsewhere.requested).toEqual([]);
    expect(s.webuiCards()).toEqual([]);
    expect(s.seen).toEqual([]);
  });

  it('混进一位封禁的群友、其余都能做：要审批，封禁的人应答回 forbidden', async () => {
    const s = await setup();
    const banned = s.attend(BANNED, { window: ROOM });
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    const result = s.call([L1, BANNED]);
    const card = await cardOf(elsewhere);
    expect(banned.answer(card, 'approve')).toMatchObject({ ok: false, refusal: 'forbidden' });
    elsewhere.answer(card, 'approve');
    expect(await result).toBe('ran');
  });
});

describe('要 owner 确认的与参与者审批合成一张', () => {
  it('owner 与 0 级群友：只有一张只有 owner 能批的，推到 WebUI 与她的 IM 私聊，不推给窗口（她自己在窗口的也不推）', async () => {
    const s = await setup();
    const ownerChat = s.attend(OWNER_QQ, { selfId: BOT });
    const ownerInRoom = s.attend(OWNER_QQ, { window: ROOM });
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    const result = s.call([OWNER_QQ, L0], CONFIRM);
    const card = await cardOf(ownerChat);
    await vi.waitFor(() => expect(s.webuiCards()).toHaveLength(1));
    expect(ownerInRoom.requested).toEqual([]);
    expect(elsewhere.requested).toEqual([]);
    expect(elsewhere.answer(card, 'approve')).toMatchObject({ ok: false, refusal: 'not-found' });
    expect(ownerChat.answer(card, 'approve')).toEqual({ ok: true });
    expect(await result).toBe('ran');
    expect(s.seen[0].participants).toEqual([OWNER_QQ]);
  });

  it('参与者里没有 owner：直接拒，不产生审批', async () => {
    const s = await setup();
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    expect(await s.call([L1, L0], CONFIRM)).toContain(INELIGIBLE);
    expect(elsewhere.requested).toEqual([]);
    expect(s.webuiCards()).toEqual([]);
  });

  it('免确认只在参与者都是 owner 时生效（含 owner 的两个身份）；混进别人落到合成的那一张', async () => {
    const s = await setup({ appConfig: { confirmOverrides: { [`tool:${CONFIRM}`]: 'off' } } });
    expect(await s.call([OWNER, OWNER_QQ], CONFIRM)).toBe('ran');
    expect(s.webuiCards()).toEqual([]);
    const result = s.call([OWNER_QQ, L0], CONFIRM);
    await vi.waitFor(() => expect(s.webuiCards()).toHaveLength(1));
    await s.answerOnWebui(s.webuiCards()[0], 'approve');
    expect(await result).toBe('ran');
  });
});

describe('审批服务：能批且覆盖才推、才算在场、才认应答', () => {
  it('先答先得：owner 在 WebUI 批过之后，窗口里 1 级群友的应答回已结算；结算带着批的人', async () => {
    const s = await setup();
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    const result = s.call([OWNER_QQ, L0]);
    const card = await cardOf(elsewhere);
    await s.answerOnWebui(card, 'approve');
    expect(await result).toBe('ran');
    expect(elsewhere.answer(card, 'approve')).toMatchObject({ ok: false, refusal: 'approval-settled' });
  });

  it('在场只算能批的：窗口里只有 0 级群友在场、owner 的各面都不在场时，发起时就按没人在场结算', async () => {
    const s = await setup({ webui: false });
    const zero = s.attend(L0, { window: ROOM });
    const out = await s.call([L1, L0]);
    expect(out).toContain('没人在场');
    expect(zero.requested).toEqual([]);
  });

  it('同一批两个调用各要一张参与者审批：一张一张推出，各按自己的批的人执行', async () => {
    const s = await setup({ webui: false });
    const one = s.attend(L1, { window: ROOM });
    const other = s.attend(L1_ELSEWHERE, { window: ROOM });
    const first = s.call([OWNER_QQ, L0], SENSITIVE, { what: 'first' });
    const second = s.call([OWNER_QQ, L0], SENSITIVE, { what: 'second' });
    const card = await cardOf(one);
    expect(other.requested, '同一会话一次只推出一张').toHaveLength(1);
    one.answer(card, 'approve');
    const next = await cardOf(other, 2);
    other.answer(next, 'approve');
    expect([await first, await second]).toEqual(['ran', 'ran']);
    expect(s.seen.map(ctx => ctx.participants)).toEqual([[L1], [L1_ELSEWHERE]]);
  });
});

describe('派生的一轮：子任务里照同样的逐动作规则判，审批推送按根会话', () => {
  /** 派它的那一轮：owner 点名开轮、0 级群友的话叠进来，两人都能派子任务、没经审批 */
  const from: FromTurn = { platform: 'onebot', participants: [OWNER_QQ, L0] };
  /** 在 ROOM 下新建的一个子任务里调一次门槛 1 的探针：按任务消息的填法，参与者取派它的那一轮的 */
  const inSubtask = async (s: Awaited<ReturnType<typeof setup>>, name: string, signal?: AbortSignal) => {
    const child = await s.host.sessionManager.use.createChildSession(ROOM, { name });
    const result = s.execute(
      SENSITIVE,
      { what: name },
      {
        sessionId: child.id,
        platform: 'onebot',
        userId: `parent:${ROOM}`,
        participants: from.participants,
        inbound: { source: 'subtask', fromTurn: from },
        signal,
      },
    );
    return { child: child.id, result };
  };

  it('owner 与 0 级群友派出的子任务里，0 级群友做不了的动作：出一张参与者审批，推给 WebUI 与根会话这个群里能批的人，按批的人执行', async () => {
    const s = await setup();
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    const zero = s.attend(L0, { window: ROOM });
    const otherRoom = s.attend(L1, { window: OTHER_ROOM });
    const ownerChat = s.attend(OWNER_QQ, { selfId: BOT });
    const { child, result } = await inSubtask(s, '整理资料');
    const card = await cardOf(elsewhere);
    expect(card).toMatchObject({ sessionId: child, chain: [{ id: child, title: '整理资料' }] });
    expect(card.origin).toEqual({ kind: 'hand', participants: [OWNER_QQ, L0] });
    await vi.waitFor(() => expect(s.webuiCards()).toHaveLength(1));
    expect(otherRoom.requested).toEqual([]);
    expect(ownerChat.requested, 'owner 的 IM 私聊只收只有她能批的').toEqual([]);
    expect(zero.answer(card, 'approve')).toMatchObject({ ok: false, refusal: 'forbidden' });
    expect(otherRoom.answer(card, 'approve')).toMatchObject({ ok: false, refusal: 'not-found' });
    expect(s.seen, '批准之前不得执行').toEqual([]);
    expect(elsewhere.answer(card, 'approve')).toEqual({ ok: true });
    expect(await result).toBe('ran');
    expect(s.seen[0].participants).toEqual([L1_ELSEWHERE]);
  });

  it('两个子任务各等一张：同时推给群里能批的人，各带自己的会话与来源链；批第一张只执行第一个，中止第二个子任务的那一轮只撤第二张', async () => {
    const s = await setup({ webui: false });
    const elsewhere = s.attend(L1_ELSEWHERE, { window: ROOM });
    const second = new AbortController();
    const one = await inSubtask(s, '甲');
    const two = await inSubtask(s, '乙', second.signal);
    await cardOf(elsewhere, 2);
    const [first, next] = elsewhere.requested;
    expect([first, next].map(card => [card.sessionId, card.chain])).toEqual([
      [one.child, [{ id: one.child, title: '甲' }]],
      [two.child, [{ id: two.child, title: '乙' }]],
    ]);
    elsewhere.answer(first, 'approve');
    expect(await one.result).toBe('ran');
    expect(s.seen.map(ctx => ctx.sessionId)).toEqual([one.child]);
    expect(elsewhere.settled).toEqual([first.id]);
    second.abort();
    expect(await two.result).toContain('发起它的回合已结束');
    expect(elsewhere.settled).toEqual([first.id, next.id]);
    expect(s.seen).toHaveLength(1);
  });
});

describe('取用判定（approveFor）按同一条三分', () => {
  const onlyOwner = (who: Identity): Verdict =>
    who.userId === OWNER_QQ.userId ? { ok: true } : { ok: false, reason: `${who.userId} 取不到` };

  it('参与者都过：放行，不出审批', async () => {
    const s = await setup();
    s.setCheck(() => ({ ok: true }));
    expect(await s.call([OWNER_QQ, L0], TAKE)).toBe('taken');
    expect(s.webuiCards()).toEqual([]);
  });

  it('有人过不了：发一道参与者审批，能批的是过得了的人（不是只有 owner 能批的那种，群窗口也收）', async () => {
    const s = await setup();
    s.setCheck(onlyOwner);
    const ownerInRoom = s.attend(OWNER_QQ, { window: ROOM });
    const zero = s.attend(L0, { window: ROOM });
    const ownerChat = s.attend(OWNER_QQ, { selfId: BOT });
    const result = s.call([OWNER_QQ, L0], TAKE);
    const card = await cardOf(ownerInRoom);
    expect(card.tool).toBe(TAKE);
    expect(ownerChat.requested).toEqual([]);
    expect(zero.answer(card, 'approve')).toMatchObject({ ok: false, refusal: 'forbidden' });
    ownerInRoom.answer(card, 'approve');
    expect(await result).toBe('taken');
  });

  it('都过不了：回第一位的原因，不出审批', async () => {
    const s = await setup();
    s.setCheck(onlyOwner);
    expect(await s.call([L0, L1], TAKE)).toBe(`refused: ${L0.userId} 取不到`);
    expect(s.webuiCards()).toEqual([]);
  });

  it('调用不在回合里：只按参与者都过判，不出审批', async () => {
    const s = await setup();
    s.setCheck(onlyOwner);
    const outside = { inbound: undefined, turnId: undefined, callId: undefined };
    expect(await s.call([OWNER_QQ], TAKE, {}, outside)).toBe('taken');
    expect(await s.call([OWNER_QQ, L0], TAKE, {}, outside)).toBe(`refused: ${L0.userId} 取不到`);
    expect(s.webuiCards()).toEqual([]);
  });

  it('可转后台的工具等审批时不转后台：让出时限到了还在等的，批了之后照常在前台做完', async () => {
    const s = await setup();
    s.setCheck(onlyOwner);
    const ownerInRoom = s.attend(OWNER_QQ, { window: ROOM });
    const result = s.call([OWNER_QQ, L0], BG_TAKE, { waitSeconds: 0 });
    const card = await cardOf(ownerInRoom);
    await new Promise(resolve => setTimeout(resolve, 20));
    ownerInRoom.answer(card, 'approve');
    expect(await result).toBe('taken');
  });

  it('要求立即转后台的：处理函数里的取用不出审批，只按参与者都过判', async () => {
    const s = await setup();
    s.setCheck(onlyOwner);
    const ownerInRoom = s.attend(OWNER_QQ, { window: ROOM });
    expect(await s.call([OWNER_QQ, L0], BG_TAKE, { runInBackground: true })).toContain('taskId');
    await vi.waitFor(() => expect(s.outcomes).toEqual([`refused: ${L0.userId} 取不到`]));
    expect(ownerInRoom.requested).toEqual([]);
    expect(s.webuiCards()).toEqual([]);
  });

  it('处理函数里等着的审批随这次调用中止撤销（工具撤回登记），中止了的调用不转后台', async () => {
    const s = await setup();
    s.setCheck(onlyOwner);
    const release = s.holdTake();
    const ownerInRoom = s.attend(OWNER_QQ, { window: ROOM });
    const result = s.call([OWNER_QQ, L0], BG_TAKE, { waitSeconds: 0 });
    await cardOf(ownerInRoom);
    s.withdrawBgTake();
    await vi.waitFor(() => expect(ownerInRoom.settled).toHaveLength(1));
    // 让出时限早已到了、处理函数还没落定：中止了的调用照旧在前台等它
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    expect(await result).toContain('需要批准的操作没有执行');
  });
});

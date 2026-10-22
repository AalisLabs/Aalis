import { afterEach, describe, expect, it } from 'vitest';
import { takeFrom } from '../../packages/api-session-manager/src/index.js';
import type { SessionSettingsLayer } from '../../packages/api-session-settings/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { storedRoom } from '../fixtures/rooms.js';
import { ONEBOT_TYPES, startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 取别的会话的东西一条规则（会话管理的 canTake）：同一会话、同一棵会话树放行；任一边的根会话判不出（不在会话表里、按 id
// 兜底建档的空记录、只记了出生平台的旧记录）拒绝；再按当前会话的范围（本会话、同平台、全部）；最后只看目标：同平台两个机器人
// 账号之间要「跨机器人账号」，多方要「读别的群」，一对一是授权身份自己的私聊放行、否则要「读别人的私聊」。owner 的面（WebUI、
// 终端、项目会话）按与 owner 的一对一。范围与三个开关是会话管理的按会话字段，按当前会话取生效值，对所有人一样。
// ════════════════════════════════════════════════════════════

const SM = '@aalis/plugin-session-manager';
const G1 = 'onebot:10000:group:20001';
const G2 = 'onebot:10000:group:20002';
/** 群成员 A 与她的私聊 */
const PA = 'onebot:10000:private:30001';
/** 群成员 B 与她的私聊 */
const PB = 'onebot:10000:private:30002';
/** owner 在 onebot 上与她的私聊 */
const PO = 'onebot:10000:private:39999';
/** 另一个机器人账号下的群，与 A 的私聊 */
const G3 = 'onebot:10001:group:20003';
const PA_BOT2 = 'onebot:10001:private:30001';
/** 另一个平台的群，机器人账号与 onebot 的不同 */
const X1 = 'chat2:group:40001';
/** 没声明类型的平台：整个按一对一记，对端是收录时的第一位发言者 */
const L1 = 'loose:u1';
const L2 = 'loose:u2';
const W1 = 'session-web00001';
const W2 = 'session-web00002';
/** G1 里派出的子任务 */
const CHILD = 'session-child001';
/** 升级前只记了出生平台、没有聊天窗口的私聊记录 */
const OLD = 'onebot:10000:private:30003';
/** 按 id 兜底建档的空记录 */
const UNFILED = 'session-unfiled1';
/** 不在会话表里：会话表没有的群、编排的一次性会话、没写目标会话的定时任务 */
const MISSING = 'onebot:10000:group:29999';
const WORKFLOW = 'workflow::run1::node1';
const SCHEDULER = 'scheduler::job1';

const A = { platform: 'onebot', userId: '30001' };
const OWNER_IM = { platform: 'onebot', userId: '39999' };
const CONSOLE = { platform: 'webui', userId: 'console' };

const base = { children: [], status: 'waiting', createdAt: 0, updatedAt: 0 };
const STORED: Record<string, Record<string, unknown>> = {
  ...Object.fromEntries([G1, G2, PA, PB, PO, G3, PA_BOT2].map(id => [id, storedRoom(id)])),
  [X1]: {
    ...base,
    id: X1,
    originPlatform: 'chat2',
    originChat: { type: 'group', multiParty: true, selfId: '777', targetId: '40001' },
  },
  [L1]: {
    ...base,
    id: L1,
    originPlatform: 'loose',
    originChat: { type: 'private', multiParty: false, targetId: 'u1' },
  },
  [L2]: {
    ...base,
    id: L2,
    originPlatform: 'loose',
    originChat: { type: 'private', multiParty: false, targetId: 'u2' },
  },
  [W1]: { ...base, id: W1, createdFrom: 'webui' },
  [W2]: { ...base, id: W2, createdFrom: 'webui' },
  [CHILD]: { ...base, id: CHILD, parentId: G1 },
  [OLD]: { ...base, id: OLD, originPlatform: 'onebot' },
  [UNFILED]: { ...base, id: UNFILED },
};
/** G1 所在窗口的场所记录：场所层的值写在这里 */
const G1_PLACE = 'onebot:group:20001';
const PLACES = { [G1_PLACE]: { key: G1_PLACE, kind: 'window', name: '<群名>', createdAt: 0, updatedAt: 0 } };

type Write = [target: { sessionId: string } | { layer: SessionSettingsLayer }, key: string, value: unknown];

interface Row {
  current: string;
  target: string;
  principal?: { platform: string; userId: string };
  /** 宿主配置文档里本插件的全局层与平台档 */
  global?: Record<string, unknown>;
  platforms?: Record<string, Record<string, unknown>>;
  /** 经会话设置的管理面写的场所层与本会话层 */
  writes?: Write[];
  /** 权限服务不在 */
  noAuthority?: boolean;
  /** ok 或拒绝原因的键 */
  expected: 'ok' | 'takeUnknown' | 'scopeSession' | 'scopePlatform' | 'crossBot' | 'otherGroups' | 'othersPrivate';
}

const atG1 = (key: string, value: unknown): Write => [{ layer: { scope: 'place', key: G1_PLACE } }, key, value];
const atSession = (sessionId: string, key: string, value: unknown): Write => [{ sessionId }, key, value];

const ROWS: Record<string, Row> = {
  '别人的私聊：群里读同平台别人与她的私聊默认拒绝': { current: G1, target: PB, expected: 'othersPrivate' },
  '别人的私聊：群的场所层打开「读别人的私聊」后放行': {
    current: G1,
    target: PB,
    writes: [atG1('takeOthersPrivate', true)],
    expected: 'ok',
  },
  '自己的私聊：群成员 A 读 A 与她的私聊放行，不用开关': { current: G1, target: PA, principal: A, expected: 'ok' },
  '自己的私聊：群成员 A 读 B 与她的私聊拒绝': { current: G1, target: PB, principal: A, expected: 'othersPrivate' },
  '自己的私聊：owner 在 WebUI 范围设成全部，读她 IM 账号与 owner 的私聊放行（两边都是 owner 的身份）': {
    current: W1,
    target: PO,
    principal: CONSOLE,
    platforms: { webui: { takeScope: 'all' } },
    expected: 'ok',
  },
  '自己的私聊：owner 在 WebUI 范围设成全部，读别人的私聊拒绝': {
    current: W1,
    target: PB,
    principal: CONSOLE,
    platforms: { webui: { takeScope: 'all' } },
    expected: 'othersPrivate',
  },
  '自己的私聊：授权身份在别的平台上、账号号码与对端相同，不算本人': {
    current: G1,
    target: PA,
    principal: { platform: 'chat2', userId: '30001' },
    expected: 'othersPrivate',
  },
  '自己的私聊：没声明类型的平台上按一对一记下的窗口，对端就是授权身份也要开关': {
    current: L2,
    target: L1,
    principal: { platform: 'loose', userId: 'u1' },
    expected: 'othersPrivate',
  },
  '别的群：默认放行': { current: G1, target: G2, expected: 'ok' },
  '别的群：当前群的场所层关掉「读别的群」后拒绝': {
    current: G1,
    target: G2,
    writes: [atG1('takeOtherGroups', false)],
    expected: 'otherGroups',
  },
  '别的群：私聊读群同样受它管': {
    current: PA,
    target: G1,
    principal: A,
    writes: [atSession(PA, 'takeOtherGroups', false)],
    expected: 'otherGroups',
  },
  '跨机器人账号：同平台两个机器人账号下的两个群默认拒绝': { current: G1, target: G3, expected: 'crossBot' },
  '跨机器人账号：打开后放行': {
    current: G1,
    target: G3,
    platforms: { onebot: { takeCrossBot: true } },
    expected: 'ok',
  },
  '跨机器人账号：对端是授权身份本人的私聊挂在另一个机器人账号下同样拒绝': {
    current: G1,
    target: PA_BOT2,
    principal: A,
    expected: 'crossBot',
  },
  '跨机器人账号：范围为全部时读别的平台的群只看范围': {
    current: G1,
    target: X1,
    writes: [atSession(G1, 'takeScope', 'all')],
    expected: 'ok',
  },
  '范围本会话：群里派出的子任务读父群放行': {
    current: CHILD,
    target: G1,
    writes: [atG1('takeScope', 'session')],
    expected: 'ok',
  },
  '范围本会话：群里派出的子任务读别的群拒绝': {
    current: CHILD,
    target: G2,
    writes: [atG1('takeScope', 'session')],
    expected: 'scopeSession',
  },
  '范围同平台：读别的平台的会话拒绝': { current: G1, target: X1, expected: 'scopePlatform' },
  范围写坏了按本会话: { current: G1, target: G2, global: { takeScope: 'everything' }, expected: 'scopeSession' },
  开关写坏了按否: { current: G1, target: G2, global: { takeOtherGroups: 'yes' }, expected: 'otherGroups' },
  读别人的私聊写坏了按否: { current: G1, target: PB, global: { takeOthersPrivate: 'yes' }, expected: 'othersPrivate' },
  跨机器人账号写坏了按否: { current: G1, target: G3, global: { takeCrossBot: 'yes' }, expected: 'crossBot' },
  '判不出：范围全部时读会话表里没有的会话拒绝': {
    current: G1,
    target: MISSING,
    global: { takeScope: 'all' },
    expected: 'takeUnknown',
  },
  '判不出：范围全部时读按 id 兜底建档的空记录拒绝': {
    current: G1,
    target: UNFILED,
    global: { takeScope: 'all' },
    expected: 'takeUnknown',
  },
  '判不出：两个会话都不在会话表里、id 不同，范围全部也拒绝': {
    current: WORKFLOW,
    target: SCHEDULER,
    global: { takeScope: 'all' },
    expected: 'takeUnknown',
  },
  '判不出：只有出生平台、没有聊天窗口的私聊记录，默认从同平台的群读拒绝': {
    current: G1,
    target: OLD,
    expected: 'takeUnknown',
  },
  '判不出：当前会话不在会话表里（编排的一次性会话）读别的会话拒绝': {
    current: WORKFLOW,
    target: G1,
    global: { takeScope: 'all' },
    expected: 'takeUnknown',
  },
  'WebUI 守同平台：默认读 IM 群拒绝': { current: W1, target: G1, principal: CONSOLE, expected: 'scopePlatform' },
  'WebUI 守同平台：读别的 WebUI 会话放行': { current: W1, target: W2, principal: CONSOLE, expected: 'ok' },
  'WebUI 守同平台：WebUI 平台档的范围设成全部后读群放行': {
    current: W1,
    target: G1,
    principal: CONSOLE,
    platforms: { webui: { takeScope: 'all' } },
    expected: 'ok',
  },
  '目标是 owner 的面：群的范围设成全部，群成员 A 读 owner 的 WebUI 会话默认拒绝': {
    current: G1,
    target: W1,
    principal: A,
    writes: [atG1('takeScope', 'all')],
    expected: 'othersPrivate',
  },
  '目标是 owner 的面：owner 在群里读放行': {
    current: G1,
    target: W1,
    principal: OWNER_IM,
    writes: [atG1('takeScope', 'all')],
    expected: 'ok',
  },
  '目标是 owner 的面：不传授权身份时 WebUI 会话读别的 WebUI 会话拒绝': {
    current: W1,
    target: W2,
    expected: 'othersPrivate',
  },
  '目标是 owner 的面：WebUI 平台档打开「读别人的私聊」后放行': {
    current: W1,
    target: W2,
    platforms: { webui: { takeOthersPrivate: true } },
    expected: 'ok',
  },
  '目标是 owner 的面：权限服务不在时 owner 读也要开关': {
    current: W1,
    target: W2,
    principal: CONSOLE,
    noAuthority: true,
    expected: 'othersPrivate',
  },
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function verdictOf(row: Row) {
  const started = await startSettings({
    doc: {
      plugins: row.global ? { [SM]: row.global } : {},
      sessionConfig: {
        platforms: Object.fromEntries(Object.entries(row.platforms ?? {}).map(([p, values]) => [p, { [SM]: values }])),
      },
    },
    adapters: [
      { platform: 'onebot', sessionTypes: ONEBOT_TYPES },
      { platform: 'chat2', sessionTypes: ONEBOT_TYPES },
      { platform: 'loose' },
    ],
    owners: row.noAuthority ? undefined : [OWNER_IM, CONSOLE],
    stored: structuredClone(STORED),
    places: structuredClone(PLACES),
  });
  apps.push(started.app);
  for (const [target, key, value] of row.writes ?? []) await started.admin.update(target, { plugin: SM, key, value });
  return started.sm.canTake(row.current, row.target, row.principal);
}

describe('取别的会话的东西：会话管理的 canTake', () => {
  it.each(Object.entries(ROWS))('%s', async (_name, row) => {
    const verdict = await verdictOf(row);
    if (row.expected === 'ok') {
      expect(verdict).toEqual({ ok: true });
      return;
    }
    expect(verdict).toMatchObject({ ok: false, reason: { key: row.expected } });
    if (verdict.ok) return;
    expect(toSource(verdict.reason)).not.toMatch(/onebot|webui|chat2|loose|cli/i);
  });
});

describe('契约的包装函数', () => {
  it('会话管理不在：只放行同一会话 id，其余回「判不出」', () => {
    const absent = { present: false, use: undefined as never };
    expect(takeFrom(absent, G1, G1)).toEqual({ ok: true });
    expect(takeFrom(absent, G1, G2, A)).toMatchObject({ ok: false, reason: { key: 'takeUnknown' } });
  });
});

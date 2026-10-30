// ============================================================
// scope.ts — 媒体判据：一次调用能取哪些存储里的媒体
//
// 按目标分三类：会话媒体目录里的按目录名反查会话，本会话树的与调用所在会话历史里系统记下的放行，别的会话（含与本会话树
// 撞名的）交给调用方给的取用判定；不在任何会话媒体目录下的本机文件交给调用方给的本机文件判定，历史里记过的也一样。第一方的
// 两样判定由 mediaScopeOf 按一次调用给（会话管理的取用规则，经 api-session-manager 的 takeFrom；本机文件判法
// localFileInScope），发媒体、看图的工具与回复里的媒体标记都用它，经调用方给的取用判定判：工具交工具调用上下文的
// approveFor，逐个参与者判。
//
// 判据按写入方的目录约定判归属，不是隔离：同一个根里的符号链接，或能往本会话目录写文件的工具，都能把别处的媒体伪装成
// 本会话的。会话目录名取自 session-media 的 sessionDirName，换法有损（见它的说明）：种类目录与反查会话的目录名按大小写折叠比
// （大小写不敏感的卷上读到的是同一个目录），几个会话落进同一个目录时，本会话树以外的每个都要过取用判定，与本会话树撞名也一样。
// ============================================================

import type { AuthorityService, InboundTurn, UserIdentity, Verdict } from '@aalis/api-authority';
import { roomClass, rootSessionOf, type SessionManagerService, takeFrom } from '@aalis/api-session-manager';
import { isHostAbsolutePath, isStorageUri, isWebUrl, parseStorageUri } from '@aalis/api-storage';
import type { ServiceSelection } from '@aalis/core';
import { type ArchivedAttachment, type Message, WellKnownMetadataKeys } from '@aalis/schema-message';
import { MEDIA_KIND_DIRS, sessionDirName } from './session-media.js';

/**
 * 一次调用：所在的会话、平台、这一轮的参与者（授权身份）与入站回合，字段同工具调用上下文；没有授权身份的参与者为空。本机文件
 * 判法拿它取这一轮的主体
 */
export interface MediaScopeCall {
  sessionId: string;
  platform?: string;
  participants: readonly UserIdentity[];
  inbound?: InboundTurn;
}

/** 判据要的几样，由调用方按这一次调用给 */
export interface MediaScopeDeps {
  /** 会话表：会话管理在场才给，判会话树与按目录名反查会话；不给时只认调用所在会话，别的会话的媒体一律不能取 */
  sessions?: Pick<SessionManagerService, 'getSession' | 'listSessions'>;
  /** 别的会话的媒体：目录名反查出的、本会话树以外的这几个会话（至少一个）都能不能取，第一方见 {@link mediaScopeOf} */
  take: (sessionIds: readonly string[]) => Promise<boolean>;
  /** 不在任何会话媒体目录下的本机文件能不能取，第一方见 {@link mediaScopeOf} */
  local: () => Promise<boolean>;
  /** 某会话最近的历史（第一方取 200 条）：记忆不在时为空 */
  history: (sessionId: string) => Promise<readonly Message[]>;
}

/** 本机文件判法要的几样 */
export interface LocalFileDeps {
  /** 这一轮的主体（api-authority 的 principalOf）：权限服务不在时恒为 other */
  principalOf: (call: MediaScopeCall) => 'owner' | 'other';
  /** owner 判定：权限服务不在时恒为否 */
  isOwner: (platform: string, userId: string) => boolean;
  /** 会话表：会话管理在场才给；不给时判不出受众，非人回合的条款不放行 */
  sessions?: Pick<SessionManagerService, 'getSession'>;
}

/** 本机文件判法不放行时交给取用判定的：判据只回能或不能（工具过不了的一律回同一句，先判后读），这里的原因没有读者 */
const NOT_LOCAL: Verdict = { ok: false, reason: '' };

/** 会话媒体的目录，会话目录在它们下面：各种类的目录（{@link MEDIA_KIND_DIRS}）与浏览器截图的 `tmp:/browser` */
const SESSION_MEDIA_DIRS: ReadonlySet<string> = new Set([...Object.values(MEDIA_KIND_DIRS), 'tmp:/browser']);

/** 目录名的大小写折叠：只差大小写、或折叠后相同（如 `ſ` 与 `s`）的写法在大小写不敏感的卷上是同一个目录 */
const fold = (name: string) => name.toUpperCase().toLowerCase();

/**
 * 媒体地址规整成可比的形态：网址（api-storage 的 isWebUrl：http、https，协议名不分大小写）原样；存储地址规整（消 `.`、
 * `..`）；其余不是网址也不是存储地址的（相对路径、本机路径含盘符路径、`file://`、data URI，以及带反斜杠的：有的系统按
 * 目录分隔解析它）没有。`base64://…` 按根名 base64 的存储地址交出，算本机文件，没有这个根，读不出
 */
export function mediaRef(input: string): string | undefined {
  const s = input.trim();
  if (isWebUrl(s)) return s;
  if (s.includes('\\') || isHostAbsolutePath(s) || !isStorageUri(s)) return undefined;
  const { root, segments } = parseStorageUri(s);
  return `${root}:/${segments.join('/')}`;
}

/**
 * 历史里系统记下的媒体引用（经 {@link mediaRef} 规整）：入站附件清单（metadata 的 Attachments 各项的 ref）与发出的附件
 * （SentRef）。不读正文里的占位符：群友能打出伪造的
 */
export function historyMediaRefs(messages: readonly Message[]): string[] {
  const refs: string[] = [];
  for (const { metadata } of messages) {
    const attachments = metadata?.[WellKnownMetadataKeys.Attachments];
    const raws = [
      ...(Array.isArray(attachments) ? attachments.map(a => (a as ArchivedAttachment | null)?.ref) : []),
      metadata?.[WellKnownMetadataKeys.SentRef],
    ];
    for (const raw of raws) {
      const ref = typeof raw === 'string' ? mediaRef(raw) : undefined;
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/**
 * 这次调用能不能取 target（存储地址，判据先按 {@link mediaRef} 规整，调用方读规整后的那个），按目标分三类。会话媒体目录
 * （`data:/{images,audios,videos,files}/<目录>/`、`tmp:/browser/<目录>/`）里的按目录名在本会话树（根会话加它的全部子会话）与
 * 会话表里反查会话（按大小写折叠比，几个会话撞同一个目录时取并集）：
 * 1. 反查出的会话都在本会话树里，或等于调用所在会话历史里系统记下的引用（{@link historyMediaRefs}）：放行。先比目录，不中再读历史；
 * 2. 反查出本会话树以外的会话（与本会话树撞名的也算）：take 判这些会话都能取才放行，本会话树的不问；一个会话都反查不到时不能；
 * 3. 不在任何会话媒体目录下的：按 local，调用所在会话历史里记过的也一样：本机文件按地址取到的是此刻的内容，不一定是当初
 *    收发的那份。
 *
 * 媒体目录按整棵会话树（子任务里能用发起它的群里的图），历史只取调用所在会话
 */
export async function mediaInScope(
  target: string,
  call: Pick<MediaScopeCall, 'sessionId'>,
  deps: MediaScopeDeps,
): Promise<boolean> {
  const uri = mediaRef(target);
  if (!uri || !isStorageUri(uri)) return false;
  const { sessions } = deps;
  const { root, segments } = parseStorageUri(uri);
  const dir =
    segments.length >= 3 && SESSION_MEDIA_DIRS.has(`${root}:/${fold(segments[0])}`) ? fold(segments[1]) : undefined;
  const tree = sessionTree(call.sessionId, sessions);
  const named = (id: string) => fold(sessionDirName(id)) === dir;
  const mine = dir !== undefined && [...tree].some(named);
  const others =
    dir === undefined
      ? []
      : (sessions?.listSessions() ?? []).map(({ id }) => id).filter(id => !tree.has(id) && named(id));
  if (mine && others.length === 0) return true;
  if (dir === undefined) return deps.local();
  if (historyMediaRefs(await deps.history(call.sessionId)).includes(uri)) return true;
  return others.length > 0 && deps.take(others);
}

/**
 * 第一方的判据：交出这次调用判 target 的函数（{@link mediaInScope}）。两样判定都交给调用方给的取用判定 approveFor（同工具调用
 * 上下文的），check 按一个授权身份判：别的会话的媒体每个候选都过会话管理的取用规则（takeFrom，当前会话是调用所在会话），本机
 * 文件按只有这一位参与者时的 {@link localFileInScope}（主体取权限服务的 principalOf）。工具交它的工具调用上下文，逐个参与者判、
 * 有人过不了时发一道参与者审批；没有可挂审批的调用的（回复里的标记）交只按一个授权身份判的。权限服务不在时主体是 other、没人
 * 是 owner
 */
export function mediaScopeOf(
  call: MediaScopeCall & { approveFor(check: (who: UserIdentity) => Verdict): Promise<Verdict> },
  services: {
    sessionManager: Pick<ServiceSelection<SessionManagerService>, 'present' | 'use'>;
    authority: Pick<ServiceSelection<AuthorityService>, 'present' | 'use'>;
    history: MediaScopeDeps['history'];
  },
): (target: string) => Promise<boolean> {
  const { sessionManager, authority, history } = services;
  const sessions = sessionManager.present ? sessionManager.use : undefined;
  const localDeps: LocalFileDeps = {
    principalOf: turn =>
      authority.present ? authority.use.principalOf({ ...turn, platform: turn.platform ?? '' }) : 'other',
    isOwner: (platform, userId) => authority.present && authority.use.isOwner(platform, userId),
    sessions,
  };
  const judge = async (check: (who: UserIdentity) => Verdict) => (await call.approveFor(check)).ok;
  const deps: MediaScopeDeps = {
    sessions,
    take: ids =>
      judge(
        who =>
          ids.map(id => takeFrom(sessionManager, call.sessionId, id, who)).find(verdict => !verdict.ok) ?? { ok: true },
      ),
    local: () =>
      judge(who => (localFileInScope({ ...call, participants: [who] }, localDeps) ? { ok: true } : NOT_LOCAL)),
    history,
  };
  return target => mediaInScope(target, call, deps);
}

/**
 * 不属于任何会话的本机文件（存储里不在会话媒体目录下的文件）这次调用能不能取：这一轮的主体是 owner（owner 亲手那一轮，
 * 参与者都是 owner，含它的续做与它派的子任务）；或只有一位参与者、他是 owner、所在会话的房间类别不是 room（非人回合的条款，
 * 如 owner 自己会话里的定时任务、按 owner 跑的编排、mcp-server 的调用）
 */
export function localFileInScope(call: MediaScopeCall, deps: LocalFileDeps): boolean {
  if (deps.principalOf(call) === 'owner') return true;
  const { sessions, isOwner } = deps;
  const [only, ...more] = call.participants;
  if (!sessions || !only?.userId || more.length > 0 || !isOwner(only.platform, only.userId)) return false;
  const lookup = (id: string) => sessions.getSession(id);
  return roomClass(lookup(call.sessionId), lookup, isOwner) !== 'room';
}

/** 会话树的全部会话 id：根会话与它的全部子会话，连同调用所在的会话；会话管理不在时只有它自己 */
function sessionTree(sessionId: string, sessions: MediaScopeDeps['sessions']): Set<string> {
  const tree = new Set<string>();
  const lookup = (id: string) => sessions?.getSession(id);
  const root = rootSessionOf(lookup(sessionId), lookup);
  const pending = root ? [root.id] : [];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (tree.has(id)) continue;
    tree.add(id);
    pending.push(...(lookup(id)?.children ?? []));
  }
  return tree.add(sessionId);
}

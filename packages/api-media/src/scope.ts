// ============================================================
// scope.ts — 媒体按受众：一次调用能取哪些存储里的媒体
//
// 受众里没有别人（房间类别 owner-only 或 internal）、且授权身份是 owner 的调用不限；其余只认本会话树的媒体目录里的文件，
// 与调用所在会话历史里系统记下的引用。发媒体、看图的工具与出站转换共用这一份判据。
//
// 判据按写入方的目录约定判归属，不是隔离：同一个根里的符号链接，或能往本会话目录写文件的工具，都能把别处的媒体伪装成
// 本会话的。会话目录名取自 session-media 的 sessionDirName，换法有损（见它的说明）。不在会话表里的会话按 internal
// （编排与定时任务的会话不进会话表），群会话要已收录才认得出是房间。
// ============================================================

import { roomClass, rootSessionOf, type SessionInfo } from '@aalis/api-session-manager';
import { isHostAbsolutePath, isStorageUri, parseStorageUri } from '@aalis/api-storage';
import { type ArchivedAttachment, type Message, WellKnownMetadataKeys } from '@aalis/schema-message';
import { MEDIA_KIND_DIRS, sessionDirName } from './session-media.js';

/** 一次调用：所在的会话与授权身份，字段同工具调用上下文（actor 缺省即 platform、userId；没有 userId 即匿名） */
export interface MediaScopeCall {
  sessionId: string;
  platform?: string;
  userId?: string;
  actor?: { platform: string; userId: string };
}

/** 判据要的三样，由调用方按自己的服务注入 */
export interface MediaScopeDeps {
  /** 按 id 取会话记录：会话管理在场才给；不给时一律只认本会话（房间类别与会话树都判不出） */
  getSession?: (id: string) => SessionInfo | undefined;
  /** owner 判定：权限服务不在时恒为否 */
  isOwner: (platform: string, userId: string) => boolean;
  /** 某会话最近的历史（第一方取 200 条）：记忆不在时为空 */
  history: (sessionId: string) => Promise<readonly Message[]>;
}

/** 会话媒体的目录，会话目录在它们下面：各种类的目录（{@link MEDIA_KIND_DIRS}）与浏览器截图的 `tmp:/browser` */
const SESSION_MEDIA_DIRS: ReadonlySet<string> = new Set([...Object.values(MEDIA_KIND_DIRS), 'tmp:/browser']);

/**
 * 媒体地址规整成可比的形态：网址（协议名小写的 http、https，与适配器下载附件时认的一样）原样；存储地址规整（消 `.`、
 * `..`）；其余不是网址也不是存储地址的（相对路径、本机路径含盘符路径、`file://`、data URI，以及带反斜杠的：有的系统按
 * 目录分隔解析它）没有。`base64://…` 按根名 base64 的存储地址交出，过不了判据
 */
export function mediaRef(input: string): string | undefined {
  const s = input.trim();
  if (/^https?:\/\//.test(s)) return s;
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
 * 这次调用能不能取 target（存储地址，判据先按 {@link mediaRef} 规整，调用方读规整后的那个）：
 * 1. 会话管理在场、调用所在会话的房间类别不是 room，且授权身份是 owner：不限；
 * 2. 其余：target 落在本会话树（根会话加它的全部子会话）任一会话的媒体目录里（`data:/{images,audios,videos,files}/<目录>/`、
 *    `tmp:/browser/<目录>/`），或等于调用所在会话历史里系统记下的引用（{@link historyMediaRefs}）。先比目录，不中再读历史。
 *
 * 媒体目录按整棵会话树（子任务里能用发起它的群里的图），历史只取调用所在会话
 */
export async function mediaInScope(target: string, call: MediaScopeCall, deps: MediaScopeDeps): Promise<boolean> {
  const { getSession, isOwner } = deps;
  const { platform, userId } = call.actor ?? call;
  const ownerActs = platform !== undefined && !!userId && isOwner(platform, userId);
  if (getSession && ownerActs && roomClass(getSession(call.sessionId), getSession, isOwner) !== 'room') return true;
  const uri = mediaRef(target);
  if (!uri || !isStorageUri(uri)) return false;
  const { root, segments } = parseStorageUri(uri);
  if (segments.length >= 3 && SESSION_MEDIA_DIRS.has(`${root}:/${segments[0]}`)) {
    const dirs = [...sessionTree(call.sessionId, getSession)].map(sessionDirName);
    if (dirs.includes(segments[1])) return true;
  }
  return historyMediaRefs(await deps.history(call.sessionId)).includes(uri);
}

/** 会话树的全部会话 id：根会话与它的全部子会话，连同调用所在的会话；会话管理不在时只有它自己 */
function sessionTree(sessionId: string, getSession: MediaScopeDeps['getSession']): Set<string> {
  const tree = new Set<string>();
  const root = getSession ? rootSessionOf(getSession(sessionId), getSession) : undefined;
  const pending = root ? [root.id] : [];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (tree.has(id)) continue;
    tree.add(id);
    pending.push(...(getSession?.(id)?.children ?? []));
  }
  return tree.add(sessionId);
}

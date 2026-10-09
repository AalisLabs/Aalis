// ============================================================
// 本会话临时区：tmp/sessions/<会话 id 的 UTF-8 十六进制>/，0700。十六进制只有小写，大小写不敏感的文件系统上两个会话也不会撞名
//
// 有本地效果的调用签发凭据时建好；删会话时删；启动时与每天清扫一次：7 天没有改动、会话也不在运行的删掉。会话表里查不到
// 的同样按 7 天算，不立即删：会话表读不出（记忆后端暂时连不上）时表是空的，不能当作会话都删了。删除与清扫都在后台跑，
// 不拖住激活与删会话。
// 插件自己的临时目录（浏览器截图、代码执行的脚本目录）不在这里，清扫不碰。
// ============================================================

// biome-ignore lint/style/noRestrictedImports: 清扫本会话临时区要按 lstat 不跟随链接地看修改时间，存储网关没有这个能力
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionInfo } from '@aalis/api-session-manager';
import type { Logger } from '@aalis/core';
import { isMissing } from './host-dirs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 这么久没有改动的临时区，会话不在运行时清掉 */
const STALE_MS = 7 * DAY_MS;
export const SWEEP_EVERY_MS = DAY_MS;

export const sessionTmpOf = (tmp: string, sessionId: string) =>
  join(tmp, 'sessions', Buffer.from(sessionId).toString('hex'));

/** 清扫一遍，返回删掉的会话 id。逐个临时区处理：一个看不了或删不掉的记 warn（写明目录与原因），不挡别的 */
export async function sweepSessionTmp(
  tmp: string,
  sessionOf: (sessionId: string) => SessionInfo | undefined,
  now: number,
  logger: Pick<Logger, 'warn'>,
): Promise<string[]> {
  const root = join(tmp, 'sessions');
  const names = await readdir(root).catch(err => {
    if (isMissing(err)) return [];
    throw err;
  });
  const removed: string[] = [];
  for (const name of names) {
    const sessionId = Buffer.from(name, 'hex').toString();
    // 名字不是某个会话 id 的编码：不是本会话临时区，不动
    if (Buffer.from(sessionId).toString('hex') !== name) continue;
    const dir = join(root, name);
    try {
      if (sessionOf(sessionId)?.status === 'active' || (await changedSince(dir, now - STALE_MS))) continue;
      // 遍历期间会话可能开了新回合
      if (sessionOf(sessionId)?.status === 'active') continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(sessionId);
    } catch (err) {
      logger.warn(`清不掉会话 ${sessionId} 的临时区 ${dir}:`, err);
    }
  }
  return removed;
}

/** 目录或它下面任何一项在 since 之后改过（不跟随符号链接）；遍历中途被删掉的按刚改过算，这一轮不动它 */
async function changedSince(path: string, since: number): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.mtimeMs > since) return true;
    if (!entry.isDirectory()) return false;
    for (const name of await readdir(path)) {
      if (await changedSince(join(path, name), since)) return true;
    }
    return false;
  } catch (err) {
    if (isMissing(err)) return true;
    throw err;
  }
}

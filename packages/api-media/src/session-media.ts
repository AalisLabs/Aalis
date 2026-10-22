// ============================================================
// session-media.ts — 会话媒体的目录约定：会话里收发与产生的媒体写在哪、谁来清
//
// 布局 `data:/<种类目录>/<会话目录>/<写入方>/<文件>`：种类目录见 MEDIA_KIND_DIRS，会话目录由 sessionDirName 从会话 id
// 换来，写入方（onebot、media、draw，第三方用自己的名字）各写自己的子目录，引用一律写完整的存储地址。谁写的谁清：写入方
// 挂 memory:clear 中间件，按所选类型调 clearSessionMedia 清自己的子目录，/clear 与删会话都走这一条。
//
// 命名约定：按内容寻址的写入方把文件名写成内容 SHA-256 的前 16 位小写十六进制加扩展名（onebot、media 是这样），媒体识别
// 的描述缓存据此让不带会话语境的描述跨会话复用；文件名不是这种写法的（如绘图产物）按存储地址各存一条。
// ============================================================

import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { MessageAttachment } from '@aalis/schema-message';

type MediaKind = MessageAttachment['kind'];
type Storage = Pick<StorageService, 'list' | 'delete'>;

/** 各种会话媒体的目录：下面一级是会话目录，再下面是写入方的子目录 */
export const MEDIA_KIND_DIRS: Readonly<Record<MediaKind, string>> = {
  image: 'data:/images',
  audio: 'data:/audios',
  video: 'data:/videos',
  file: 'data:/files',
};

/**
 * 会话 id → 会话目录名：`:`、`/`、`\`、`..` 与前导点换成 `_`。换法有损：会话 id 不能只在这几处有区别（`x:a_b` 与
 * `x:a:b` 落进同一个目录），大小写不敏感的卷上只差大小写的也落进同一个目录。空 id 抛错：工具调用上下文的 sessionId
 * 必填，空的是调用方的缺陷
 */
export function sessionDirName(sessionId: string): string {
  if (!sessionId) throw new Error('会话 id 为空，取不出会话目录');
  return sessionId
    .replace(/[:/\\]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_');
}

/** 写入方在这个会话里这种媒体的目录：`data:/<种类目录>/<会话目录>/<写入方>` */
export function sessionMediaUri(kind: MediaKind, sessionId: string, writer: string): string {
  return `${MEDIA_KIND_DIRS[kind]}/${sessionDirName(sessionId)}/${writer}`;
}

/**
 * 删掉写入方在这种媒体里的子目录，会话目录删空了一并删掉；给会话时只删这个会话的，不给时删各会话的。回删掉的文件数，要删的
 * 不在时回 0；其余存储错误照抛
 */
export async function clearSessionMedia(
  storage: Storage,
  kind: MediaKind,
  writer: string,
  sessionId?: string,
): Promise<number> {
  const kindDir = MEDIA_KIND_DIRS[kind];
  if (sessionId !== undefined) return removeWriterDir(storage, `${kindDir}/${sessionDirName(sessionId)}`, writer);
  let removed = 0;
  for (const { name, isDirectory } of (await listDir(storage, kindDir)) ?? []) {
    if (isDirectory) removed += await removeWriterDir(storage, `${kindDir}/${name}`, writer);
  }
  return removed;
}

/** 删掉会话目录下写入方的子目录，会话目录删空了一并删掉；回删掉的文件数，子目录不在时回 0 */
async function removeWriterDir(storage: Storage, sessionDir: string, writer: string): Promise<number> {
  const dir = `${sessionDir}/${writer}`;
  const files = await listDir(storage, dir);
  if (!files) return 0;
  await storage.delete(dir);
  if ((await storage.list(sessionDir)).entries.length === 0) await storage.delete(sessionDir);
  return files.length;
}

/** 目录里的条目；目录不在时回 undefined */
async function listDir(storage: Storage, uri: string) {
  try {
    return (await storage.list(uri)).entries;
  } catch (err) {
    if (isStorageNotFound(err)) return undefined;
    throw err;
  }
}

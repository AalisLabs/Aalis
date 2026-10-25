// ============================================================
// 成品：白纸根里的目录布局、提供者交来文件的写入口、按内容判定类型
//
// 白纸文件：paper:/<目录>/tasks/<任务 id>/out/<产物 id>.<判定类型的扩展名>，工程包 paper:/<目录>/workspace.tar.gz，
// 目录名取 api-session-manager 的 paperDirName（n-<名> 或 p-<场所键的十六进制>）。远端给的相对路径（rel）只写进记录
// 供 WebUI 显示，不出现在白纸根的路径里：出站附件的 data 会被写进会话历史，远端控制的文件名不能借此进入历史与记忆。
//
// 写入口不只信提供者：rel 再按契约的 artifactRelProblem 净化一次，单文件、单轮总量、文件数、工程包与白纸目录总占用
// 各有上限，不合格就抛错（提供者把它记进 rejected）。白纸目录超过总占用上限后，本轮余下的文件一律拒收。
// ============================================================

import { type ArtifactSink, artifactRelProblem } from '@aalis/api-remote-agent';
import { paperDirName } from '@aalis/api-session-manager';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import {
  decodeUtf8Text,
  detectMediaFormat,
  FILE_HEAD_BYTES,
  MEDIA_FORMATS,
  type MediaFormat,
} from '@aalis/util-file-signature';
import type { ArtifactCaps } from './config.js';
import { randomHex, type TaskRecord } from './ledger.js';

type Artifact = TaskRecord['artifacts'][number];
type ArtifactType = Artifact['type'];

/**
 * 能发出的位图与视频：成品类型 → 文件头判定的格式，扩展名、MIME 与是不是视频都取判定表；认得出、但不在这里的媒体
 * （M4A、HEIC、MKV…）归 other
 */
const MEDIA_ARTIFACTS = {
  png: MEDIA_FORMATS.PNG,
  jpeg: MEDIA_FORMATS.JPEG,
  gif: MEDIA_FORMATS.GIF,
  webp: MEDIA_FORMATS.WebP,
  mp4: MEDIA_FORMATS.MP4,
  mov: MEDIA_FORMATS.MOV,
} satisfies Record<Exclude<ArtifactType, 'html' | 'other'>, MediaFormat>;

/** 判定类型落盘用的扩展名（paper_send 重写的文件名也用它） */
export function artifactExtension(type: ArtifactType): string {
  return type === 'html' ? 'html' : type === 'other' ? 'bin' : MEDIA_ARTIFACTS[type].ext;
}

/** 能发出的判定类型的 MIME（paper_send 发出时用） */
export function artifactMime(type: Exclude<ArtifactType, 'other'>): string {
  return type === 'html' ? 'text/html' : MEDIA_ARTIFACTS[type].mime;
}

/** 视频成品：按视频发、超限时说「视频」 */
export function isVideo(type: ArtifactType): boolean {
  return type !== 'html' && type !== 'other' && MEDIA_ARTIFACTS[type].kind === 'video';
}

/** 白纸在白纸根里的目录 */
export function paperDirUri(paperId: string): string {
  return `paper:/${paperDirName(paperId)}`;
}

/** 一件任务的成品目录 */
function taskOutUri(paperId: string, taskId: string): string {
  return `${paperDirUri(paperId)}/tasks/${taskId}/out`;
}

/** 一件成品在白纸根里的位置：文件名是宿主生成的产物 id 加判定类型的扩展名 */
export function artifactUri(paperId: string, taskId: string, artifact: Pick<Artifact, 'id' | 'type'>): string {
  return `${taskOutUri(paperId, taskId)}/${artifact.id}.${artifactExtension(artifact.type)}`;
}

/** 白纸的工程包 */
export function bundleUri(paperId: string): string {
  return `${paperDirUri(paperId)}/workspace.tar.gz`;
}

/**
 * 按内容判定类型，不看扩展名：PNG、JPEG、GIF、WebP、MP4、MOV 按文件头（@aalis/util-file-signature）；HTML 能按 UTF-8
 * 解码、去掉 BOM 与空白后以 `<!doctype html` 或 `<html` 开头（不分大小写）；其余为 other。
 */
export function sniffType(data: Uint8Array): ArtifactType {
  const format = detectMediaFormat(data.subarray(0, FILE_HEAD_BYTES));
  if (format) {
    const sendable = Object.entries(MEDIA_ARTIFACTS).find(([, media]) => media.format === format.format);
    return sendable ? (sendable[0] as ArtifactType) : 'other';
  }
  const head = decodeUtf8Text(data)?.trimStart().slice(0, 16).toLowerCase() ?? '';
  return head.startsWith('<!doctype html') || head.startsWith('<html') ? 'html' : 'other';
}

/** 目录（或文件）的实际占用：列目录逐层求和；不存在按 0 */
export async function usageOf(storage: StorageService, uri: string): Promise<number> {
  let listing: Awaited<ReturnType<StorageService['list']>>;
  try {
    listing = await storage.list(uri);
  } catch (err) {
    if (isStorageNotFound(err)) return 0;
    throw err;
  }
  let total = 0;
  for (const entry of listing.entries) total += entry.isDirectory ? await usageOf(storage, entry.uri) : entry.size;
  return total;
}

async function sizeOf(storage: StorageService, uri: string): Promise<number> {
  try {
    return (await storage.stat(uri)).size;
  } catch (err) {
    if (isStorageNotFound(err)) return 0;
    throw err;
  }
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * 一轮的写入口。先清掉这件任务之前没取完的成品目录（重启后重取时不留半截），再按白纸目录的实际占用起算。
 */
export async function openCollector(opts: {
  storage: StorageService;
  paperId: string;
  taskId: string;
  caps: ArtifactCaps;
  /** 记录里已用过的产物 id：新 id 不与它们重复 */
  takenIds: ReadonlySet<string>;
}): Promise<RunCollector> {
  const { storage, paperId, taskId } = opts;
  try {
    await storage.delete(taskOutUri(paperId, taskId));
  } catch (err) {
    if (!isStorageNotFound(err)) throw err;
  }
  const used = await usageOf(storage, paperDirUri(paperId));
  const previousBundle = await sizeOf(storage, bundleUri(paperId));
  return new RunCollector(storage, paperId, taskId, opts.caps, new Set(opts.takenIds), used, previousBundle);
}

export class RunCollector implements ArtifactSink {
  readonly artifacts: Artifact[] = [];
  /** 白纸目录超过了总占用上限：本轮余下的文件一律拒收 */
  full = false;
  #runBytes = 0;

  constructor(
    private readonly storage: StorageService,
    private readonly paperId: string,
    private readonly taskId: string,
    private readonly caps: ArtifactCaps,
    private readonly takenIds: Set<string>,
    private used: number,
    private previousBundle: number,
  ) {}

  #fits(size: number): void {
    if (this.full) throw new Error('白纸目录已满，本轮余下的文件不再收');
    if (this.used + size > this.caps.maxPaperBytes) {
      this.full = true;
      throw new Error(`白纸目录的总占用会超过上限 ${this.caps.maxPaperBytes} 字节`);
    }
  }

  async putFile(rel: string, data: Uint8Array): Promise<void> {
    const problem = artifactRelProblem(rel);
    if (problem) throw new Error(`路径不合格：${problem}`);
    const size = data.byteLength;
    if (this.artifacts.length >= this.caps.maxRunFiles) throw new Error(`超过本轮文件数上限 ${this.caps.maxRunFiles}`);
    if (size > this.caps.maxFileBytes) throw new Error(`超过单文件上限 ${this.caps.maxFileBytes} 字节`);
    if (this.#runBytes + size > this.caps.maxRunBytes)
      throw new Error(`超过本轮合计上限 ${this.caps.maxRunBytes} 字节`);
    this.#fits(size);
    const type = sniffType(data);
    let id: string;
    do id = `a-${randomHex(4)}`;
    while (this.takenIds.has(id));
    this.takenIds.add(id);
    await this.storage.writeFile(artifactUri(this.paperId, this.taskId, { id, type }), toBuffer(data));
    this.used += size;
    this.#runBytes += size;
    this.artifacts.push({ id, rel, type, sizeBytes: size });
  }

  async putBundle(data: Uint8Array): Promise<void> {
    const size = data.byteLength;
    if (size > this.caps.maxBundleBytes) throw new Error(`超过工程包上限 ${this.caps.maxBundleBytes} 字节`);
    this.#fits(size - this.previousBundle);
    await this.storage.writeFile(bundleUri(this.paperId), toBuffer(data));
    this.used += size - this.previousBundle;
    this.previousBundle = size;
  }
}

// ============================================================
// 成品：白纸根里的目录布局、提供者交来文件的写入口、按文件头判定类型
//
// 白纸文件：paper:/<目录>/tasks/<任务 id>/out/<产物 id>.<判定类型的扩展名>，工程包 paper:/<目录>/workspace.tar.gz，
// 目录名 n-<名> 或 r-<哈希前 12 位>。远端给的相对路径（rel）只记进账本供 WebUI 显示，不出现在白纸根的
// 路径里：出站附件的 data 会被写进会话历史，远端控制的文件名不能借此进入历史与记忆。
//
// 写入口不只信提供者：rel 再按同样的规则净化一次，单文件、单轮总量、文件数、工程包与白纸目录总占用
// 各有上限，不合格就抛错（提供者把它记进 rejected）。白纸目录超过总占用上限后，本轮余下的文件一律拒收。
// ============================================================

import type { ArtifactSink } from '@aalis/api-remote-agent';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { ArtifactCaps } from './config.js';
import { randomHex, type TaskRecord } from './ledger.js';

type Artifact = TaskRecord['artifacts'][number];
type ArtifactType = Artifact['type'];

/** 各判定类型落盘用的扩展名（paper_send 重写的文件名也用它） */
export const EXTENSIONS: Record<ArtifactType, string> = {
  png: 'png',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  mp4: 'mp4',
  html: 'html',
  other: 'bin',
};

/** 白纸在白纸根里的目录 */
export function paperDirUri(paperId: string): string {
  return `paper:/${paperId.replace(':', '-')}`;
}

/** 一件任务的成品目录 */
function taskOutUri(paperId: string, taskId: string): string {
  return `${paperDirUri(paperId)}/tasks/${taskId}/out`;
}

/** 一件成品在白纸根里的位置：文件名是宿主生成的产物 id 加判定类型的扩展名 */
export function artifactUri(paperId: string, taskId: string, artifact: Pick<Artifact, 'id' | 'type'>): string {
  return `${taskOutUri(paperId, taskId)}/${artifact.id}.${EXTENSIONS[artifact.type]}`;
}

/** 白纸的工程包 */
export function bundleUri(paperId: string): string {
  return `${paperDirUri(paperId)}/workspace.tar.gz`;
}

/** 远端给的相对路径能否落账；不能时返回原因（与提供者同一套规则） */
function relProblem(rel: string): string | undefined {
  if (rel === '') return '路径为空';
  if (rel.startsWith('/')) return '绝对路径';
  if (rel.includes('\\')) return '路径含反斜杠';
  if (/[\p{Cc}\p{Cf}]/u.test(rel)) return '路径含控制字符或不可见的格式字符';
  const segments = rel.split('/');
  if (segments.includes('..')) return '路径含 .. 段';
  if (segments.some(s => s === '' || s === '.')) return '路径含空段或 . 段';
  return undefined;
}

function startsWith(data: Uint8Array, offset: number, magic: readonly number[]): boolean {
  return data.byteLength >= offset + magic.length && magic.every((b, i) => data[offset + i] === b);
}

const ascii = (s: string) => [...s].map(c => c.charCodeAt(0));

/**
 * 按文件头判定类型：PNG、JPEG、GIF、WebP、MP4 看魔数；HTML 须扩展名为 .html 或 .htm、能按 UTF-8 解码、
 * 去掉 BOM 与空白后以 `<!doctype html` 或 `<html` 开头（不分大小写）；其余为 other。
 */
export function sniffType(rel: string, data: Uint8Array): ArtifactType {
  if (startsWith(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(data, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(data, 0, ascii('GIF87a')) || startsWith(data, 0, ascii('GIF89a'))) return 'gif';
  if (startsWith(data, 0, ascii('RIFF')) && startsWith(data, 8, ascii('WEBP'))) return 'webp';
  if (startsWith(data, 4, ascii('ftyp'))) return 'mp4';
  if (/\.html?$/i.test(rel)) {
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      return 'other';
    }
    const head = body.replace(/^﻿/, '').trimStart().slice(0, 16).toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  }
  return 'other';
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
  /** 账本里已用过的产物 id：新 id 不与它们重复 */
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
  bundle?: { sizeBytes: number };
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
    const problem = relProblem(rel);
    if (problem) throw new Error(`路径不合格：${problem}`);
    const size = data.byteLength;
    if (this.artifacts.length >= this.caps.maxRunFiles) throw new Error(`超过本轮文件数上限 ${this.caps.maxRunFiles}`);
    if (size > this.caps.maxFileBytes) throw new Error(`超过单文件上限 ${this.caps.maxFileBytes} 字节`);
    if (this.#runBytes + size > this.caps.maxRunBytes)
      throw new Error(`超过本轮合计上限 ${this.caps.maxRunBytes} 字节`);
    this.#fits(size);
    const type = sniffType(rel, data);
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
    this.bundle = { sizeBytes: size };
  }
}

// ============================================================
// loader.ts — workspace/workflows/*.yaml 加载与持久化
//
// 通过 @aalis/api-storage 访问目录与文件（默认 workspace:/workflows）。
// ============================================================

import type { UserIdentity } from '@aalis/api-authority';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { WorkflowDef } from '@aalis/api-workflow';
import type { Logger } from '@aalis/core';
import { parse, stringify } from 'yaml';

import { validateGraph } from './engine.js';

/** 把 raw YAML 对象规范化为 WorkflowDef；返回 null 表示非法 */
export function normalizeDef(raw: unknown, fallbackId: string): WorkflowDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? fallbackId);
  const trigger = r.trigger as WorkflowDef['trigger'] | undefined;
  const nodes = Array.isArray(r.nodes) ? (r.nodes as WorkflowDef['nodes']) : [];
  if (!trigger?.type || nodes.length === 0) return null;
  const def: WorkflowDef = {
    id,
    name: typeof r.name === 'string' ? r.name : id,
    description: typeof r.description === 'string' ? r.description : undefined,
    vars: r.vars && typeof r.vars === 'object' ? (r.vars as Record<string, unknown>) : {},
    trigger,
    nodes,
    enabled: r.enabled !== false,
  };
  return def;
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function joinUri(base: string, rel: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${rel.replace(/^\/+/, '')}`;
}

export class WorkflowLoader {
  private storage: StorageService;
  private dirUri: string;
  private logger: Logger;
  private loaded = new Map<string, WorkflowDef>();
  /** 定义者：不写进定义文件，记在运行历史文件的账本里（见 RunStore），没有的即匿名 */
  private definers = new Map<string, UserIdentity>();
  /** 本次激活里确认有文件的 id（loadAll 载入的、saveDef 写过的）：只有它们删不掉文件时会在重启后被重新载入 */
  private onDisk = new Set<string>();

  constructor(storage: StorageService, dirUri: string, logger: Logger) {
    this.storage = storage;
    this.dirUri = dirUri;
    this.logger = logger;
  }

  list(): WorkflowDef[] {
    return [...this.loaded.values()];
  }

  get(id: string): WorkflowDef | undefined {
    return this.loaded.get(id);
  }

  /** 定义者，没有即匿名 */
  definedBy(id: string): UserIdentity | undefined {
    return this.definers.get(id);
  }

  /**
   * 扫描存储 → 内存。失败的文件记 warn 跳过。返回扫描是否成功：目录不存在算成功（零定义），列目录失败算失败。
   * definerOf 按 id 与文件文本的哈希给出定义者，给不出的（手写的、被改过的）没有定义者
   */
  async loadAll(definerOf: (id: string, sha256: string) => UserIdentity | undefined): Promise<boolean> {
    let entries: Array<{ name: string; uri: string; isDirectory: boolean }> = [];
    try {
      const listed = await this.storage.list(this.dirUri);
      entries = listed.entries.filter(e => !e.isDirectory && /\.(ya?ml)$/i.test(e.name));
    } catch (err) {
      if (isStorageNotFound(err)) return true;
      this.logger.warn(`扫描目录失败: ${err}`);
      return false;
    }
    for (const e of entries) {
      try {
        const text = String(await this.storage.readFile(e.uri, 'utf-8'));
        const raw = parse(text);
        const fallbackId = e.name.replace(/\.(yaml|yml)$/i, '');
        const def = normalizeDef(raw, fallbackId);
        if (!def) {
          this.logger.warn(`workflow 文件格式不合法: ${e.name}`);
          continue;
        }
        const err = validateGraph(def);
        if (err) {
          this.logger.warn(`workflow "${def.id}" 校验失败: ${err}`);
          continue;
        }
        this.putMemory(def, definerOf(def.id, await sha256(text)));
        this.onDisk.add(def.id);
        this.logger.info(`已加载 workflow: ${def.id} (${def.nodes.length} 节点, trigger=${def.trigger.type})`);
      } catch (err) {
        this.logger.warn(`加载 workflow 文件 ${e.name} 失败: ${err}`);
      }
    }
    return true;
  }

  /** 保存定义到存储（覆盖），返回写进文件的文本的哈希；放进内存另经 putMemory */
  async saveDef(def: WorkflowDef): Promise<string> {
    const uri = joinUri(this.dirUri, `${def.id}.yaml`);
    const text = stringify(def);
    await this.storage.writeFile(uri, text);
    this.onDisk.add(def.id);
    return await sha256(text);
  }

  /**
   * 从存储与内存删除。确认有文件的定义删不掉文件（不是「不存在」）时抛错、内存不动——否则重启后定义又被载入；
   * 只在内存里的定义与不存在的 id 删文件失败（如 storage 不在场、根不可删）只记 warn，照常从内存移除
   */
  async removeDef(id: string): Promise<boolean> {
    const uri = joinUri(this.dirUri, `${id}.yaml`);
    try {
      await this.storage.delete(uri);
    } catch (err) {
      if (!isStorageNotFound(err)) {
        if (this.onDisk.has(id)) {
          throw new Error(`删除 workflow 文件 ${id}.yaml 失败: ${err instanceof Error ? err.message : err}`);
        }
        this.logger.warn(`删除 workflow 文件 ${id}.yaml 失败: ${err}`);
      }
    }
    this.onDisk.delete(id);
    this.definers.delete(id);
    return this.loaded.delete(id);
  }

  /** 放入内存，定义者换成 definer（载入与定义都经它） */
  putMemory(def: WorkflowDef, definer: UserIdentity | undefined): void {
    this.loaded.set(def.id, def);
    if (definer) this.definers.set(def.id, definer);
    else this.definers.delete(def.id);
  }
}

// ============================================================
// loader.ts — workspace/workflows/*.yaml 加载与持久化
//
// 通过 @aalis/plugin-storage-api 访问目录与文件（默认 workspace:/workflows）。
// ============================================================

import type { Logger } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';
import type { WorkflowDef } from '@aalis/plugin-workflow-api';
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

function joinUri(base: string, rel: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${rel.replace(/^\/+/, '')}`;
}

export class WorkflowLoader {
  private storage: StorageService;
  private dirUri: string;
  private logger: Logger;
  private loaded = new Map<string, WorkflowDef>();

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

  /** 扫描存储 → 内存。失败的文件记 warn 跳过 */
  async loadAll(): Promise<void> {
    let entries: Array<{ name: string; uri: string; isDirectory: boolean }> = [];
    try {
      const listed = await this.storage.list(this.dirUri);
      entries = listed.entries.filter(e => !e.isDirectory && /\.(ya?ml)$/i.test(e.name));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/ENOENT|not found|不存在/i.test(msg)) {
        this.logger.warn(`扫描目录失败: ${err}`);
      }
      return;
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
        this.loaded.set(def.id, def);
        this.logger.info(`已加载 workflow: ${def.id} (${def.nodes.length} 节点, trigger=${def.trigger.type})`);
      } catch (err) {
        this.logger.warn(`加载 workflow 文件 ${e.name} 失败: ${err}`);
      }
    }
  }

  /** 保存定义到存储（覆盖） */
  async saveDef(def: WorkflowDef): Promise<void> {
    const uri = joinUri(this.dirUri, `${def.id}.yaml`);
    await this.storage.writeFile(uri, stringify(def));
    this.loaded.set(def.id, def);
  }

  /** 从内存与存储删除 */
  async removeDef(id: string): Promise<boolean> {
    const had = this.loaded.delete(id);
    const uri = joinUri(this.dirUri, `${id}.yaml`);
    try {
      await this.storage.delete(uri);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/ENOENT|not found|不存在/i.test(msg)) {
        this.logger.warn(`删除 workflow 文件 ${id}.yaml 失败: ${err}`);
      }
    }
    return had;
  }

  /** 仅放入内存（用于动态注册不持久化） */
  putMemory(def: WorkflowDef): void {
    this.loaded.set(def.id, def);
  }
}

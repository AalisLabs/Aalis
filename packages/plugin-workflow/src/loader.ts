// ============================================================
// loader.ts — workspace/workflows/*.yaml 加载与持久化
// ============================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '@aalis/core';
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

export class WorkflowLoader {
  private dir: string;
  private logger: Logger;
  private loaded = new Map<string, WorkflowDef>();

  constructor(dir: string, logger: Logger) {
    this.dir = resolve(dir);
    this.logger = logger;
  }

  ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  list(): WorkflowDef[] {
    return [...this.loaded.values()];
  }

  get(id: string): WorkflowDef | undefined {
    return this.loaded.get(id);
  }

  /** 扫描磁盘 → 内存。失败的文件记 warn 跳过 */
  loadAll(): void {
    this.ensureDir();
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch (err) {
      this.logger.warn(`扫描目录失败: ${err}`);
      return;
    }
    for (const f of files) {
      const full = join(this.dir, f);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        const text = readFileSync(full, 'utf-8');
        const raw = parse(text);
        const fallbackId = f.replace(/\.(yaml|yml)$/i, '');
        const def = normalizeDef(raw, fallbackId);
        if (!def) {
          this.logger.warn(`workflow 文件格式不合法: ${f}`);
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
        this.logger.warn(`加载 workflow 文件 ${f} 失败: ${err}`);
      }
    }
  }

  /** 保存定义到磁盘（覆盖） */
  saveDef(def: WorkflowDef): void {
    this.ensureDir();
    const full = join(this.dir, `${def.id}.yaml`);
    writeFileSync(full, stringify(def), 'utf-8');
    this.loaded.set(def.id, def);
  }

  /** 从内存与磁盘删除 */
  removeDef(id: string): boolean {
    const had = this.loaded.delete(id);
    const full = join(this.dir, `${id}.yaml`);
    if (existsSync(full)) {
      try {
        unlinkSync(full);
      } catch (err) {
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

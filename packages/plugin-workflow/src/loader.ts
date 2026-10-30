// ============================================================
// loader.ts — workspace/workflows/*.yaml 加载与持久化
//
// 通过 @aalis/api-storage 访问目录与文件（默认 workspace:/workflows）。
// ============================================================

import type { UserIdentity } from '@aalis/api-authority';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { WorkflowDef } from '@aalis/api-workflow';
import type { Logger } from '@aalis/core';
import { TextError, type TextRef, textOf, toSource } from '@aalis/schema-i18n';
import { parse, stringify } from 'yaml';

import { validateGraph } from './engine.js';
import { t } from './texts.js';

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

/**
 * 新定义的 id 是新定义文件的文件名（`<id>.yaml`，拼进定义目录的路径）：只收各种文字的字母（含泰文、天城文与 NFD 写法要用的组合
 * 符号）、数字、下划线与连字符，带 `/` 或 `..` 的会把写引到定义目录之外；看不见的韩文填充字母（U+115F、U+1160、U+3164、U+FFA0）
 * 不收，页面上显示为空白。不合规时给原因。已有文件的定义改写与删除都对它载入时的文件，不经这里
 */
export function validateId(id: string): TextRef | null {
  return /^[\p{L}\p{M}\p{N}_-]+$/u.test(id) && !/[\u115F\u1160\u3164\uFFA0]/u.test(id) ? null : t('badId', { id });
}

/** 定义文件里写的 id，与载入同一条：没写的取文件名；不是 YAML 的同样取文件名 */
function declaredId(text: string, fallbackId: string): string {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return fallbackId;
  }
  const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : undefined;
  return String(id ?? fallbackId);
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
  /** 定义者：不写进定义文件，记在运行历史文件的记录里（见 RunStore），没有的即匿名 */
  private definers = new Map<string, UserIdentity>();
  /**
   * 有文件的定义（loadAll 载入的、saveDef 写过的）各自的文件：改写与删除都对它，不按 id 拼路径——文件名可以与 id 不同、可以是
   * .yml，拼出的 `<id>.yaml` 可能是另一条定义的文件。只有它们删不掉文件时会在重启后被重新载入
   */
  private files = new Map<string, string>();

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
   * id 不按新定义的字符集拒（它不拼路径），只拒空的与带 `/`、`\`、NUL 的。
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
        if (!def.id || /[/\\\0]/.test(def.id)) {
          this.logger.warn(`workflow 文件 ${e.name} 的 id 为空或带 /、\\、NUL，不载入: ${JSON.stringify(def.id)}`);
          continue;
        }
        const err = validateGraph(def);
        if (err) {
          this.logger.warn(`workflow "${def.id}" 校验失败: ${toSource(err)}`);
          continue;
        }
        this.putMemory(def, definerOf(def.id, await sha256(text)));
        this.files.set(def.id, e.uri);
        this.logger.info(`已加载 workflow: ${def.id} (${def.nodes.length} 节点, trigger=${def.trigger.type})`);
      } catch (err) {
        this.logger.warn(`加载 workflow 文件 ${e.name} 失败: ${err}`);
      }
    }
    return true;
  }

  /**
   * 保存定义到存储，返回写进文件的文本的哈希；放进内存另经 putMemory。有文件的定义写回它自己的文件；新定义按 `<id>.yaml` 起名，
   * 这个文件已经存在、存的是另一个 id 的定义时（另一条定义的文件名恰好是它，或卷不分大小写与字形、另一个 id 的文件被它命中）
   * 报错、不写
   */
  async saveDef(def: WorkflowDef): Promise<string> {
    const uri = this.files.get(def.id) ?? (await this.newFile(def.id));
    const text = stringify(def);
    await this.storage.writeFile(uri, text);
    this.files.set(def.id, uri);
    return await sha256(text);
  }

  /** 新定义的文件：`<id>.yaml`，已经存在的按实际读到的文件判归属，存的是这个 id 的（如载入不了的旧定义）照常覆盖 */
  private async newFile(id: string): Promise<string> {
    const file = `${id}.yaml`;
    const uri = joinUri(this.dirUri, file);
    let text: string;
    try {
      text = String(await this.storage.readFile(uri, 'utf-8'));
    } catch (err) {
      if (isStorageNotFound(err)) return uri;
      throw err;
    }
    const other = declaredId(text, id);
    if (other !== id) throw new TextError(t('fileTaken', { file, other, id }));
    return uri;
  }

  /**
   * 从存储与内存删除已载入的定义（别的 id 不该走到这里，见 removeWorkflow）。有文件的定义删的是它自己的文件，删不掉（不是
   * 「不存在」）时抛错、内存不动——否则重启后定义又被载入；只在内存里的定义没有文件，不碰存储
   */
  async removeDef(id: string): Promise<void> {
    const uri = this.files.get(id);
    if (uri) {
      try {
        await this.storage.delete(uri);
      } catch (err) {
        if (!isStorageNotFound(err)) {
          throw new TextError(t('deleteFileFailed', { file: uri.slice(uri.lastIndexOf('/') + 1), error: textOf(err) }));
        }
      }
    }
    this.files.delete(id);
    this.definers.delete(id);
    this.loaded.delete(id);
  }

  /** 放入内存，定义者换成 definer（载入与定义都经它） */
  putMemory(def: WorkflowDef, definer: UserIdentity | undefined): void {
    this.loaded.set(def.id, def);
    if (definer) this.definers.set(def.id, definer);
    else this.definers.delete(def.id);
  }
}

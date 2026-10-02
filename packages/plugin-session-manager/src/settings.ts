// ════════════════════════════════════════════════════════════
// 会话设置：插件登记的设置项，与会话之上的各层（全局默认、平台档、受众条目）。
//
// session-manager 不认识任何具体的键：登记过的键按登记的字段校验与解析，没登记的（插件没装或没启用）原样留在存储里、
// 不参与解析。各层存放在宿主配置文档的 sessionConfig 字段里：它们是「下次启动用什么」的配置，跟着配置文件走，
// 可以手写，也能由脚手架生成；插件配置的 schema 词汇装不下任意类型的值，所以不放在本插件的配置里。
// ════════════════════════════════════════════════════════════

import { isDeepStrictEqual } from 'node:util';
import type {} from '@aalis/api-host-config'; // declaration merging 锚点（下方 AalisConfig 增强）
import {
  type RegisteredSessionSetting,
  type RoomAudience,
  SessionConfigError,
  type SessionConfigLayer,
  type SessionKind,
  type SessionSetting,
  type SettingProminence,
} from '@aalis/api-session-manager';
import { isBuiltinFieldType, isUnsafeConfigKey, parseConfig, validateConfig } from '@aalis/schema-config';

/** 一个会话或一层里的设置值：键 → 值，原样存储 */
export type SettingValues = Record<string, unknown>;

type Audience = Exclude<RoomAudience, 'owner'>;

/**
 * 宿主配置文档的 sessionConfig 字段：会话设置在会话之上的各层，由 session-manager 读写。全局默认、平台档（按平台名）、
 * 受众条目（按平台名，再分群与私聊）。值按插件登记的设置项解析，没启用的插件的键原样保留
 */
interface SessionConfigDoc {
  defaults?: SettingValues;
  platforms?: Record<string, SettingValues>;
  audiences?: Record<string, Partial<Record<Audience, SettingValues>>>;
}

declare module '@aalis/api-host-config' {
  interface AalisConfig {
    sessionConfig?: SessionConfigDoc;
  }
}

export const AUDIENCE_NAMES: Record<Audience, string> = { group: '群', private: '私聊' };

const KINDS: ReadonlySet<SessionKind> = new Set(['owner', 'room', 'task']);
const PROMINENCES: ReadonlySet<SettingProminence> = new Set(['composer', 'common', 'advanced']);

/**
 * 键与形状不对的登记一律拒绝：键会成为存储与配置文档里的对象键，种类与显眼程度决定界面怎么放；外来字段类型的取值
 * schema-config 不校验，没有 validate 就没人核
 */
function assertSetting(setting: SessionSetting): void {
  const { field, appliesTo, prominence } = setting;
  // 类型只约束第一方的写法：按任意值核
  const key: unknown = setting.key;
  if (typeof key !== 'string' || key === '' || key === 'sessionDefaults' || isUnsafeConfigKey(key)) {
    throw new TypeError(`会话设置项的键不合法：${String(key)}`);
  }
  if (typeof field?.type !== 'string' || typeof field.label !== 'string') {
    throw new TypeError(`会话设置项 ${key} 的字段要有 type 与 label`);
  }
  if (!isBuiltinFieldType(field.type) && typeof setting.validate !== 'function') {
    throw new TypeError(`会话设置项 ${key} 的字段类型 ${field.type} 不由 schema-config 校验取值，要给出 validate`);
  }
  if (!Array.isArray(appliesTo) || appliesTo.length === 0 || !appliesTo.every(kind => KINDS.has(kind))) {
    throw new TypeError(`会话设置项 ${key} 的 appliesTo 要是 owner、room、task 里的一项或几项`);
  }
  if (!PROMINENCES.has(prominence)) {
    throw new TypeError(`会话设置项 ${key} 的显眼程度要是 composer、common、advanced 之一`);
  }
}

/** 已登记的设置项。几个插件登记同一个键时须是同一份内容的定义，键在最后一个登记者撤回时才失效 */
export class SettingRegistry {
  /** 键 → 登记者，先登记的在前 */
  readonly #byKey = new Map<string, Array<{ setting: SessionSetting; plugin: string }>>();

  constructor(private readonly changed: () => void) {}

  register(setting: SessionSetting, plugin: string): () => void {
    assertSetting(setting);
    const entries = this.#byKey.get(setting.key) ?? [];
    const first = entries[0];
    if (first && !isDeepStrictEqual(first.setting, setting)) {
      throw new Error(`会话设置项 ${setting.key} 已由 ${first.plugin} 以另一份定义登记`);
    }
    const entry = { setting, plugin };
    entries.push(entry);
    this.#byKey.set(setting.key, entries);
    this.changed();
    return () => {
      const current = this.#byKey.get(setting.key);
      const index = current?.indexOf(entry) ?? -1;
      if (!current || index < 0) return;
      current.splice(index, 1);
      if (current.length === 0) this.#byKey.delete(setting.key);
      this.changed();
    };
  }

  get(key: string): SessionSetting | undefined {
    return this.#byKey.get(key)?.[0]?.setting;
  }

  /** 按键最先登记的先后；几个插件登记的取最先登记、仍在场的那个 */
  list(): RegisteredSessionSetting[] {
    return [...this.#byKey.values()].map(([{ setting, plugin }]) => ({ ...setting, plugin }));
  }
}

/**
 * 按登记的 validate 与字段读一个值：合法时给出解析后的值（undefined 等于没设，如外来类型的空串），不合法时给出原因
 */
export function readSetting(setting: SessionSetting, value: unknown): { value: unknown } | { invalid: string } {
  const rejected = setting.validate?.(value);
  if (rejected !== undefined) return { invalid: rejected };
  const schema = { [setting.key]: setting.field };
  const record = { [setting.key]: value };
  const [issue] = validateConfig(schema, record);
  if (issue) return { invalid: issue.message };
  return { value: parseConfig(schema, record)[setting.key] };
}

/**
 * 校验一份写入：没登记的键与不合字段的值抛 {@link SessionConfigError}；null 与 undefined 是删掉这一项（记为 undefined），
 * 没登记的键也能删
 */
export function checkPatch(registry: SettingRegistry, patch: object): Map<string, unknown> {
  const checked = new Map<string, unknown>();
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      checked.set(key, undefined);
      continue;
    }
    const setting = registry.get(key);
    if (!setting) throw new SessionConfigError(`会话设置项 ${key} 没有登记（提供它的插件没装或没启用）`);
    const read = readSetting(setting, value);
    if ('invalid' in read) throw new SessionConfigError(`会话设置项 ${key} 的值无效：${read.invalid}`);
    checked.set(key, read.value);
  }
  return checked;
}

/** 把校验过的写入合到一份值上，返回新对象：undefined 删掉这一项 */
export function applyPatch(values: object | undefined, patch: Map<string, unknown>): SettingValues {
  const out: SettingValues = { ...values };
  for (const [key, value] of patch) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** 宿主配置文档里的各层，形状已核过 */
export interface Layers {
  defaults?: SettingValues;
  platforms: Map<string, SettingValues>;
  audiences: Map<string, Partial<Record<Audience, SettingValues>>>;
}

const isRecord = (value: unknown): value is SettingValues =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 一张「名字 → 对象」的表：值不是对象的条目告警后忽略 */
function readTable(value: unknown, path: string, warn: (message: string) => void): Map<string, SettingValues> {
  const table = new Map<string, SettingValues>();
  if (value === undefined) return table;
  if (!isRecord(value)) {
    warn(`宿主配置 ${path} 不是对象，已忽略`);
    return table;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (isRecord(entry)) table.set(name, entry);
    else warn(`宿主配置 ${path}.${name} 不是对象，已忽略`);
  }
  return table;
}

const LAYER_KEYS: ReadonlySet<string> = new Set(['defaults', 'platforms', 'audiences']);

/**
 * 读出文档里的各层：形状不对的部分与不认识的键告警后忽略（按层写时整份重写，它们不再写回）；值本身在解析时按登记的
 * 字段校验
 */
export function readLayers(doc: unknown, warn: (message: string) => void): Layers {
  if (doc !== undefined && !isRecord(doc)) {
    warn('宿主配置 sessionConfig 不是对象，已忽略');
    return { platforms: new Map(), audiences: new Map() };
  }
  for (const key of Object.keys(doc ?? {})) {
    if (!LAYER_KEYS.has(key)) {
      warn(
        `宿主配置 sessionConfig.${key} 不认识（只有 defaults、platforms、audiences），已忽略；从界面改任一层时会从配置文件删掉`,
      );
    }
  }
  const { defaults, platforms, audiences } = doc ?? {};
  if (defaults !== undefined && !isRecord(defaults)) warn('宿主配置 sessionConfig.defaults 不是对象，已忽略');
  const byAudience = new Map<string, Partial<Record<Audience, SettingValues>>>();
  for (const [platform, entry] of readTable(audiences, 'sessionConfig.audiences', warn)) {
    const parts: Partial<Record<Audience, SettingValues>> = {};
    for (const [audience, values] of Object.entries(entry)) {
      const path = `sessionConfig.audiences.${platform}.${audience}`;
      if (audience !== 'group' && audience !== 'private') warn(`宿主配置 ${path} 不是 group 或 private，已忽略`);
      else if (!isRecord(values)) warn(`宿主配置 ${path} 不是对象，已忽略`);
      else parts[audience] = values;
    }
    byAudience.set(platform, parts);
  }
  return {
    defaults: isRecord(defaults) ? defaults : undefined,
    platforms: readTable(platforms, 'sessionConfig.platforms', warn),
    audiences: byAudience,
  };
}

/** 层的标识要能当配置文档里的对象键：平台名非空、不是原型链上的名字，受众只有群与私聊 */
export function assertLayer(layer: SessionConfigLayer): void {
  if (layer.scope === 'defaults') return;
  if (layer.scope !== 'platform' && layer.scope !== 'audience') {
    throw new SessionConfigError(`会话设置的层不认识：${String((layer as { scope: unknown }).scope)}`);
  }
  if (typeof layer.platform !== 'string' || layer.platform === '' || isUnsafeConfigKey(layer.platform)) {
    throw new SessionConfigError(`平台名不合法：${String(layer.platform)}`);
  }
  if (layer.scope === 'audience' && layer.audience !== 'group' && layer.audience !== 'private') {
    throw new SessionConfigError(`受众只能是 group 或 private：${String(layer.audience)}`);
  }
}

/** 这一层自己的原样值 */
export function rawLayer(layers: Layers, layer: SessionConfigLayer): SettingValues | undefined {
  if (layer.scope === 'defaults') return layers.defaults;
  if (layer.scope === 'platform') return layers.platforms.get(layer.platform);
  return layers.audiences.get(layer.platform)?.[layer.audience];
}

/** 文档里写了的各层：全局默认总在第一个，其后平台档按平台名、受众条目按平台名与受众排 */
export function listLayers(layers: Layers): SessionConfigLayer[] {
  const result: SessionConfigLayer[] = [{ scope: 'defaults' }];
  for (const platform of [...layers.platforms.keys()].sort()) result.push({ scope: 'platform', platform });
  for (const platform of [...layers.audiences.keys()].sort()) {
    for (const audience of ['group', 'private'] as const) {
      if (layers.audiences.get(platform)?.[audience]) result.push({ scope: 'audience', platform, audience });
    }
  }
  return result;
}

/** 换掉一层的值，整理成文档的形状：空了的层与表删掉，形状不对、已被忽略的部分不再写回 */
export function writeLayer(layers: Layers, layer: SessionConfigLayer, values: SettingValues): SessionConfigDoc {
  const keep = (v: SettingValues | undefined) => (v && Object.keys(v).length > 0 ? v : undefined);
  const platforms = new Map(layers.platforms);
  const audiences = new Map(layers.audiences);
  let defaults = layers.defaults;
  if (layer.scope === 'defaults') defaults = values;
  else if (layer.scope === 'platform') platforms.set(layer.platform, values);
  else audiences.set(layer.platform, { ...audiences.get(layer.platform), [layer.audience]: values });

  const doc: SessionConfigDoc = {};
  if (keep(defaults)) doc.defaults = defaults;
  const platformEntries = [...platforms].filter(([, v]) => keep(v));
  if (platformEntries.length > 0) doc.platforms = Object.fromEntries(platformEntries);
  const audienceEntries = [...audiences].flatMap(([platform, parts]) => {
    const kept = Object.fromEntries(Object.entries(parts).filter(([, v]) => keep(v)));
    return Object.keys(kept).length > 0 ? [[platform, kept] as const] : [];
  });
  if (audienceEntries.length > 0) doc.audiences = Object.fromEntries(audienceEntries);
  return doc;
}

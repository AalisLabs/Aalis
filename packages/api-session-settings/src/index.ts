// ----- 会话设置契约 -----
//
// 插件在自己的 configSchema 顶层字段上写 `session`，声明这一项可按会话覆盖：宿主不把它交给插件的运行态配置
// （caps.config 里没有），插件在 apply 里调 `fields()` 拿读取器，调用路径上按会话读生效值。改这类字段不重载插件。
//
// 层（后面的压过前面的）：全局（插件配置）› 平台档 › 平台类型档 › 场所 › 本会话。要对所有群生效的设置按平台分别设在平台类型档。
// 全局层就是插件配置里的值；平台档、平台类型档在宿主配置文档的 sessionConfig 里；场所与本会话在会话管理的记录上。
// 解析只在本包的 resolveFields 一处做：读取器在插件进程内调它，提供者（@aalis/plugin-session-settings）只交出原样的层值。
// 提供者缺席时读取器只取全局层，插件配置里的值照常生效。

import type { OwnHostConfig } from '@aalis/api-host-config';
import type { SessionKind } from '@aalis/api-session-manager';
import { type BindingPort, defineService, type ServiceSelection } from '@aalis/core';
import {
  type ConfigSchema,
  isBuiltinFieldType,
  isSessionField,
  readFieldValue,
  type SchemaField,
  type SessionFieldSpec,
  type SessionFieldsOf,
  type WireSchemaField,
} from '@aalis/schema-config';
import { asText, type TextRef, toSource, withText } from '@aalis/schema-i18n';
import { t } from './texts.js';

declare module '@aalis/schema-config' {
  interface SessionFieldSpec {
    /** 适用的会话种类：不适用的会话只取全局层与作者默认，也不收这一项的写入。不写即适用全部会话种类（含子会话） */
    appliesTo?: readonly SessionKind[];
    /** 只能设到场所为止：本会话层不收它，会话记录上存着的值也不参与解析 */
    narrowest?: 'place';
    /**
     * 显眼程度：composer 也出现在输入框旁的快捷切换（同一组最多两项，多出的按先后退到 common），common 在设置里排在前面，
     * advanced 收进默认折叠的「高级」，按实例分组
     */
    prominence: 'composer' | 'common' | 'advanced';
    /** 同一显眼程度里的先后，小的在前；不写排在写了的后面 */
    order?: number;
    /**
     * 可选项依赖同一 schema 里的另一个带标记字段（字段名）：取可选项时带上那一项的生效值，那一项没设时带它的 actual。
     * 本字段要有 dynamicOptions
     */
    dependsOn?: string;
    /** 哪一层都没有值时的含义（如「跟随服务偏好」）：字段没有 default 时必须写，有 default 的不写 */
    unset?: string | TextRef;
    /** 改本会话这一层的门槛：1 级或 2 级；不写即只有 owner 能改。往上各层另有固定的门槛 */
    minLevel?: 1 | 2;
    /**
     * 全局层不在插件配置里，由声明它的插件实例对这个服务的本插件偏好承担：值经字段的 toText、fromText 与偏好的
     * contextId 互换。不能有 default，不能写 narrowest；插件配置段里手写了这个键不生效，读取器告警一次
     */
    preference?: string;
  }
}

/** sessionConfig：平台档（平台名）、平台类型档（平台名再类型名），每处按插件实例 id 放这个实例的值 */
export interface SessionConfigDoc {
  platforms?: Record<string, Record<string, Record<string, unknown>>>;
  platformTypes?: Record<string, Record<string, Record<string, Record<string, unknown>>>>;
}

declare module '@aalis/api-host-config' {
  interface AalisConfig {
    sessionConfig?: SessionConfigDoc;
  }
}

/** 层表：先后即生效顺序（后面的压过前面的）。称呼是文字对象，按读者语言显示 */
export const SESSION_LAYERS = [
  { name: 'global', label: t('layerGlobal') },
  { name: 'platform', label: t('layerPlatform') },
  { name: 'platformType', label: t('layerPlatformType') },
  { name: 'place', label: t('layerPlace') },
  { name: 'session', label: t('layerSession') },
] as const;
export type SessionLayerName = (typeof SESSION_LAYERS)[number]['name'];

/** 值的来源：层名；'default' 是全局层的值缺失或不合法、按作者默认 */
export type SessionSource = SessionLayerName | 'default';

/**
 * 会话之上能单独读写的一层：平台名、类型名非空、不含 `:`、不是 `*`；场所键是已有的场所记录。本会话层按会话 id 读写
 */
export type SessionSettingsLayer =
  | { scope: 'global' }
  | { scope: 'platform'; platform: string }
  | { scope: 'platformType'; platform: string; type: string }
  | { scope: 'place'; key: string };

/** 读取时调用方给的入口：platform 是入口平台，只对没有出生平台的会话起作用 */
export interface SessionAt {
  platform?: string;
}

/** 一个会话在全局之上的各层：只含这一个实例写过的原样值（提供者交出的是复制品） */
export interface SessionChain {
  /** 会话的种类；会话不在会话表里、根会话是空记录时没有（不按 appliesTo 筛） */
  kind?: SessionKind;
  /** 场所的种类（api-session-manager 的 placeKind）；没有场所层时没有 */
  placeKind?: SessionKind;
  /** 按层表先后排好：platform、platformType、place、session；where 是日志里的称呼 */
  parts: Array<{ layer: Exclude<SessionLayerName, 'global'>; where: string; values: Record<string, unknown> }>;
}

/**
 * 校验声明，不合格抛 TypeError 点名字段（fields() 调它，插件因此激活失败）：session 只写在顶层字段上；不同时写 secret 或
 * required；appliesTo（写了的）、prominence、narrowest、minLevel 的取值；dependsOn 指向另一个带标记字段且本字段有 dynamicOptions；外来
 * 字段类型带 validate；没有 default 的写非空的 unset；写了 preference 的值非空、带 toText 与 fromText、没有 default 与 narrowest
 */
export function assertSessionFields(schema: ConfigSchema): void {
  for (const [key, entry] of Object.entries(schema)) {
    const nested = 'fields' in entry ? entry.fields : entry.type === 'array' ? entry.items : undefined;
    for (const [inner, field] of Object.entries(nested ?? {})) {
      if (field.session !== undefined) throw new TypeError(`字段 ${key}.${inner}：session 只能写在顶层字段上`);
    }
    if (!isSessionField(entry)) continue;
    const fail = (rule: string): never => {
      throw new TypeError(`可按会话覆盖的字段 ${key}：${rule}`);
    };
    const spec = entry.session;
    if (entry.secret === true || entry.required === true) fail('不能同时写 secret 或 required');
    const kinds: unknown = spec.appliesTo;
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every(kind => KINDS.has(kind)))) {
      fail('appliesTo 不写，或是 owner、room、task 里的一项或几项');
    }
    if (!PROMINENCES.has(spec.prominence)) fail('prominence 要是 composer、common、advanced 之一');
    if (spec.narrowest !== undefined && spec.narrowest !== 'place') fail('narrowest 只能是 place');
    if (spec.minLevel !== undefined && spec.minLevel !== 1 && spec.minLevel !== 2) fail('minLevel 只能是 1 或 2');
    if (spec.dependsOn !== undefined) {
      if (spec.dependsOn === key || !isSessionField(schema[spec.dependsOn])) {
        fail('dependsOn 要是同一 schema 里另一个可按会话覆盖的字段');
      }
      if (entry.dynamicOptions === undefined) fail('声明了 dependsOn，字段要有 dynamicOptions');
    }
    if (!isBuiltinFieldType(entry.type) && typeof entry.validate !== 'function') {
      fail(`字段类型 ${entry.type} 不由 schema-config 校验取值，要给出 validate`);
    }
    const hasDefault = entry.default !== undefined;
    if (!hasDefault && (spec.unset === '' || asText(spec.unset) === undefined)) {
      fail('没有 default 时要写一句非空的 unset');
    }
    if (spec.preference !== undefined) {
      if (typeof spec.preference !== 'string' || spec.preference === '') fail('preference 要是非空的服务名');
      if (typeof entry.toText !== 'function' || typeof entry.fromText !== 'function') {
        fail('写了 preference，字段要带 toText 与 fromText');
      }
      if (hasDefault || spec.narrowest !== undefined) fail('写了 preference，不能有 default 或 narrowest');
    }
  }
}

const KINDS: ReadonlySet<unknown> = new Set<SessionKind>(['owner', 'room', 'task']);
const PROMINENCES: ReadonlySet<unknown> = new Set(['composer', 'common', 'advanced']);

/** 这一项适用于这种会话：appliesTo 不写即适用全部会话种类 */
export const appliesIn = (spec: SessionFieldSpec, kind: SessionKind): boolean => spec.appliesTo?.includes(kind) ?? true;

/** 层表里这一层的称呼 */
export const layerLabel = (name: SessionLayerName): TextRef => SESSION_LAYERS.find(layer => layer.name === name)!.label;

/** 会话设置不在（插件没装、没启用，或会话管理没起来）时的说法：读取器写不了，协议的设置方法回 unsupported */
export const SETTINGS_ABSENT = t('settingsAbsent');

/** 日志里点名一层的写法：层的称呼（原文）加选的是哪一份，如「平台类型档 onebot · group」「场所 <场所键>」 */
export function describeLayer(layer: SessionSettingsLayer): string {
  const label = toSource(layerLabel(layer.scope));
  if (layer.scope === 'platform') return `${label} ${layer.platform}`;
  if (layer.scope === 'platformType') return `${label} ${layer.platform} · ${layer.type}`;
  if (layer.scope === 'place') return `${label} ${layer.key}`;
  return label;
}

/**
 * 一处写下的值里这一项的取值：合法的给换算后的值；严格字段（onInvalid: 'error'）的坏值原样给出、由插件按拒绝处理；其余坏值
 * 当作没设（两种都告警）。没有这一项、或值是没设的写法时为 undefined
 */
function layerValue(
  key: string,
  field: SchemaField,
  values: Record<string, unknown>,
  where: string,
  warn: (message: string) => void,
): { value: unknown } | undefined {
  if (!Object.hasOwn(values, key)) return undefined;
  const raw = values[key];
  const read = readFieldValue(field, raw);
  if (!('invalid' in read)) return read.value === undefined ? undefined : { value: read.value };
  if (field.onInvalid === 'error') {
    warn(`设置项 ${key}（${where}）取值无效（${toSource(read.invalid)}），原样交给插件按拒绝处理`);
    return { value: raw };
  }
  warn(`设置项 ${key}（${where}）取值无效（${toSource(read.invalid)}），按没设置处理`);
  return undefined;
}

/**
 * 解析一个实例的带标记字段（读取器与提供者共用，唯一一份，校验只在这里做）。每一项：会话种类已知且不适用时只取全局层与
 * 作者默认；否则依次叠全局层与 chain 的各层（后面的压过前面的），只能设到场所的跳过本会话层，场所层只在 appliesTo 含场所
 * 种类时生效；每个值过 readFieldValue（见 layerValue）；哪层都没有时取 default（来源 default），没有 default 的不给值。
 * global 是全局层的原样值：写了 preference 的项由调用方决定给不给
 */
export function resolveFields(
  schema: ConfigSchema,
  global: Record<string, unknown>,
  chain: SessionChain,
  warn: (message: string) => void,
): { values: Record<string, unknown>; sources: Record<string, SessionSource> } {
  const values: Record<string, unknown> = {};
  const sources: Record<string, SessionSource> = {};
  for (const [key, entry] of Object.entries(schema)) {
    if (!isSessionField(entry)) continue;
    const spec = entry.session;
    const fromGlobal = layerValue(key, entry, global, describeLayer({ scope: 'global' }), warn);
    if (fromGlobal) {
      values[key] = fromGlobal.value;
      sources[key] = 'global';
    }
    if (chain.kind === undefined || appliesIn(spec, chain.kind)) {
      for (const part of chain.parts) {
        if (part.layer === 'session' && spec.narrowest === 'place') continue;
        if (part.layer === 'place' && !(chain.placeKind && appliesIn(spec, chain.placeKind))) continue;
        const read = layerValue(key, entry, part.values, part.where, warn);
        if (!read) continue;
        values[key] = read.value;
        sources[key] = part.layer;
      }
    }
    if (sources[key] === undefined && entry.default !== undefined) {
      values[key] = structuredClone(entry.default);
      sources[key] = 'default';
    }
  }
  return { values, sources };
}

/** 读取器：插件在 apply 里调 fields() 拿到，按会话读自己的带标记字段 */
export interface SessionFieldReader<S extends ConfigSchema> {
  /** 生效值。不给 sessionId 时只取全局层与作者默认 */
  get(sessionId?: string, at?: SessionAt): SessionFieldsOf<S>;
  /** 本实例在各层自己写的值（诊断用）：全局在前，场所另带场所种类，会话上的不列；只含取值合法的项（严格字段的坏值原样） */
  layers(): Array<{ layer: SessionSettingsLayer; placeKind?: SessionKind; values: Partial<SessionFieldsOf<S>> }>;
  /**
   * 写本实例一个字段在某个会话本会话层的值（null 即恢复继承）：实例由门面按本插件的实例 id 填，只写本会话层，校验同提供者的
   * update。会话设置不在时抛 {@link SessionSettingsError}
   */
  set<K extends keyof SessionFieldsOf<S> & string>(
    sessionId: string,
    key: K,
    value: SessionFieldsOf<S>[K] | null,
  ): Promise<void>;
}

/**
 * 字段没设时此刻实际在用的值，由声明字段的插件给出：用于显示，也用于建子会话时写下没设的项。label 是显示用的称呼
 */
export type ActualValue = (
  sessionId: string | undefined,
  at: SessionAt,
) => { value: unknown; label?: string | TextRef } | undefined;

/** 读取门面：按会话读、写自己字段的插件与列「操作门槛」的权限插件声明它 */
export interface SessionFields {
  /**
   * 在 apply 里调一次：校验声明（不合格抛错，激活失败），把 schema、读全局原样值的闭包与 actual 登记给会话设置（随激活撤回），
   * 返回读取器。from 就是插件的 caps：uses 里声明了 config（core 内置）与 `document: optional(ownHostConfig)`；宿主不提供
   * 文档时全局值取 config 里的同名键
   */
  fields<const S extends ConfigSchema>(
    schema: S,
    from: {
      config: ServiceSelection<Readonly<Record<string, unknown>>>;
      document: ServiceSelection<OwnHostConfig>;
    },
    actual?: { readonly [K in keyof SessionFieldsOf<S>]?: ActualValue },
  ): SessionFieldReader<S>;
  /** 已登记的各项（只读，不含值）。提供者缺席时访问抛错，调用方先看 present */
  getAll(): SessionFieldEntry[];
}

/** 一个已登记的带标记字段：实例 id、字段名、称呼与声明的门槛（没写 minLevel 即只有 owner） */
export interface SessionFieldEntry {
  plugin: string;
  key: string;
  label: string | TextRef;
  minLevel?: 1 | 2;
}

/** 一个实例的带标记字段在全局之外写过的一处：层（场所另带场所种类），或某个会话的本会话层 */
export type SessionPlacement = {
  key: string;
  value: unknown;
  at: { layer: SessionSettingsLayer; placeKind?: SessionKind } | { sessionId: string };
};

/**
 * 可以设的一层：平台类型档另带适配器声明的类型显示名（没声明时没有），场所另带场所的显示名，窗口场所另带平台与类型名（从平台档、
 * 平台类型档继承来的值取的是哪一份）
 */
export interface SessionSettingsLayerInfo {
  layer: SessionSettingsLayer;
  label?: string | TextRef;
  platform?: string;
  type?: string;
}

/** 设置的一行：(plugin, key) 是身份 */
export type SessionFieldRow = {
  /** 实例 id */
  plugin: string;
  /** 字段名 */
  key: string;
  /** 字段声明原样（含 session），去掉函数成员；default 在这里 */
  field: WireSchemaField & { session: SessionFieldSpec };
  /** 生效的显眼程度：同一组 composer 超过两项时多出的退到 common */
  prominence: 'composer' | 'common' | 'advanced';
  /** 这一处自己写的原样值；全局层是插件配置里的原样值，不合法也照样给出 */
  value?: unknown;
  /** 解析到这一处为止的生效值（校验过） */
  effective?: unknown;
  source?: SessionSource;
  /** 字段解析下来没设时，声明它的插件交来的此刻实际在用的值；取行时现算 */
  actual?: { value: unknown; label?: string | TextRef };
};

/** 提供者（@aalis/plugin-session-settings 实现） */
export interface SessionSettingsService {
  /** 只由门面经 registrar 调用；readGlobal 交全局层的原样值（不校验） */
  register(
    plugin: string,
    schema: ConfigSchema,
    readGlobal: () => Record<string, unknown>,
    actual: Readonly<Record<string, ActualValue>>,
  ): () => void;
  /** 只由读取器调用：这个会话在全局之上的各层原样值的复制品（不需要实例已登记） */
  chain(plugin: string, sessionId: string, at?: SessionAt): SessionChain;
  /** 一个实例的带标记字段在全局之外写过的每一处，扁平列出 */
  placements(plugin: string): SessionPlacement[];
  /** 已登记的各项，不含值：按登记先后与 schema 键序 */
  getAll(): SessionFieldEntry[];
  /** 可以设的各层 */
  layers(): SessionSettingsLayerInfo[];
  /** 一组行：会话的（只列适用于它的项），或一层的（只列这一层可写的项） */
  rows(target: { sessionId: string; at?: SessionAt } | { layer: SessionSettingsLayer }): SessionFieldRow[];
  /**
   * 写一项；value 为 null 即删掉这一处（全局层是恢复默认，其余层是恢复继承）。全部写入校验都在这里，不判门槛，不合的抛
   * {@link SessionSettingsError}。写宿主文档的几层先改内存里的文档再落盘，落盘失败时带回 saveError、不撤回
   */
  update(
    target: { sessionId: string } | { layer: SessionSettingsLayer },
    item: { plugin: string; key: string; value: unknown },
  ): Promise<{ saveError?: unknown }>;
  /**
   * 建子会话时并进 metadata 的一段：父会话此刻每一项适用于子会话的生效值，没有值的取 actual，父会话自己那一层里没登记的
   * 实例的条目原样带上。建会话的插件在建之前调，把它并进 createSession 的 metadata
   */
  childMetadata(parentId: string, at?: SessionAt): Record<string, unknown>;
  /**
   * 以 identity 的身份写一个会话本会话层的一项，与 `/session.set` 不带 `--at` 的写法是同一份实现：认项、文字读法、门槛
   * （经权限服务，权限服务不在时拒绝）与回执。写成与否都回一句回执
   */
  setAs(
    identity: { platform: string; userId: string },
    sessionId: string,
    item: string,
    text: string,
  ): Promise<{ ok: boolean; text: TextRef }>;
}

/** 管理面交出的方法：提供者的这几项加 fields 与 getAll（register 与 chain 只由读取器调） */
export type SessionSettingsAdmin = Pick<
  SessionSettingsService,
  'placements' | 'layers' | 'rows' | 'update' | 'childMetadata' | 'setAs'
> &
  SessionFields;

/** 写会话设置被拒或会话设置不在：用 {@link isSessionSettingsError} 判定，不用 instanceof；给人看的原因挂在 text 上 */
export class SessionSettingsError extends Error {
  override name = 'SessionSettingsError';
}

/** 判定会话设置的拒绝：只按 name 判定，进程里装了两份本包时也认得 */
export function isSessionSettingsError(err: unknown): boolean {
  return (err as { name?: unknown } | null | undefined)?.name === 'SessionSettingsError';
}

/** 带给人看的原因的 {@link SessionSettingsError} */
export function sessionSettingsError(text: TextRef): SessionSettingsError & { readonly text: TextRef } {
  return withText(new SessionSettingsError(toSource(text)), text);
}

declare module '@aalis/core' {
  interface AalisEvents {
    /** 宿主文档以外的设置变了：场所与会话记录上的值、字段登记增减、会话增删。宿主文档的变化另有 host-config:changed */
    'session-settings:changed': [];
  }
}

/** 门面登记给提供者的一份 */
interface Registration {
  schema: ConfigSchema;
  readGlobal: () => Record<string, unknown>;
  actual: Readonly<Record<string, ActualValue>>;
}

/** 两个门面共用的 fields()：登记与读取都按这次激活的实例 id，register 与 chain 不交给消费方 */
function fieldsFor(port: BindingPort<SessionSettingsService>): SessionFields['fields'] {
  return (schema, from, actual = {}) => {
    assertSessionFields(schema);
    const keys = Object.keys(schema).filter(key => isSessionField(schema[key]));
    const fieldOf = (key: string) => schema[key] as SchemaField & { session: SessionFieldSpec };
    const warned = new Set<string>();
    const warn = (message: string) => {
      if (warned.has(message)) return;
      warned.add(message);
      port.logger.warn(message);
    };
    /** 全局层的原样值（复制品）：写了 preference 的键不在这里，手写在配置段里的告警一次 */
    const readGlobal = (): Record<string, unknown> => {
      const doc = from.document.present ? from.document.use.get() : structuredClone({ ...from.config.use });
      const global: Record<string, unknown> = {};
      for (const key of keys) {
        if (!Object.hasOwn(doc, key)) continue;
        if (fieldOf(key).session.preference === undefined) global[key] = doc[key];
        else warn(`plugins.${port.id}.${key} 不生效：这一项的全局层在本插件的服务偏好里`);
      }
      return global;
    };
    port
      .registrar<Registration>({
        key: () => 'fields',
        register: (provider, item) => provider.register(port.id, item.schema, item.readGlobal, item.actual),
      })
      .add({ schema, readGlobal, actual: actual as Readonly<Record<string, ActualValue>> });
    /** 一处写下的值里取值合法的项（与解析同一判定） */
    const own = (values: Record<string, unknown>, where: string) => {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const read = layerValue(key, fieldOf(key), values, where, warn);
        if (read) out[key] = read.value;
      }
      return out;
    };
    type Values = SessionFieldsOf<typeof schema>;
    return {
      get: (sessionId, at = {}) =>
        resolveFields(
          schema,
          readGlobal(),
          sessionId !== undefined && port.present ? port.provider.chain(port.id, sessionId, at) : { parts: [] },
          warn,
        ).values as Values,
      layers() {
        const out: ReturnType<SessionFieldReader<typeof schema>['layers']> = [
          {
            layer: { scope: 'global' },
            values: own(readGlobal(), describeLayer({ scope: 'global' })) as Partial<Values>,
          },
        ];
        if (!port.present) return out;
        const groups = new Map<
          string,
          { layer: SessionSettingsLayer; placeKind?: SessionKind; raw: Record<string, unknown> }
        >();
        for (const { key, value, at } of port.provider.placements(port.id)) {
          if ('sessionId' in at) continue;
          const id = JSON.stringify(at.layer);
          const group = groups.get(id) ?? { ...at, raw: {} };
          group.raw[key] = value;
          groups.set(id, group);
        }
        for (const { raw, ...where } of groups.values()) {
          out.push({ ...where, values: own(raw, describeLayer(where.layer)) as Partial<Values> });
        }
        return out;
      },
      async set(sessionId, key, value) {
        if (!port.present) throw sessionSettingsError(SETTINGS_ABSENT);
        await port.provider.update({ sessionId }, { plugin: port.id, key, value });
      },
    };
  };
}

/** 读取门面：按会话读、写自己字段的插件与列「操作门槛」的权限插件声明它，拿不到提供者的写方法 */
export const sessionFields = defineService<SessionSettingsService, SessionFields>('session-settings', port => ({
  fields: fieldsFor(port),
  getAll: () => port.provider.getAll(),
}));

/** 管理面：只给会话服务与子任务插件（建子会话、父会话改子会话的设置）。显式列出交出的方法，不经原型链 */
export const sessionSettings = defineService<SessionSettingsService, SessionSettingsAdmin>('session-settings', port => {
  const provider = port.provider;
  return {
    fields: fieldsFor(port),
    getAll: () => provider.getAll(),
    placements: plugin => provider.placements(plugin),
    layers: () => provider.layers(),
    rows: target => provider.rows(target),
    update: (target, item) => provider.update(target, item),
    childMetadata: (parentId, at) => provider.childMetadata(parentId, at),
    setAs: (identity, sessionId, item, text) => provider.setAs(identity, sessionId, item, text),
  };
});

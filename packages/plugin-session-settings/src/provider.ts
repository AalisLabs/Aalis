// ════════════════════════════════════════════════════════════
// session-settings 服务的提供者：字段登记、各层原样值的读取（chain，读取器在插件进程内经 resolveFields 解析）、写入与校验、
// 建子会话时写下的那一层，以及协议与界面用的行、层与写过的各处。
//
// 平台档、平台类型档在宿主配置文档的 sessionConfig 里，每次现读、不缓存；场所与本会话在会话管理的记录上
// （metadata['session-settings'].values，数组里一条一项，不拿实例 id 当对象键），写入跟随会话管理的落盘。
// ════════════════════════════════════════════════════════════

import { parseWindowKey } from '@aalis/api-gateway';
import type { HostConfig } from '@aalis/api-host-config';
import { getPlatformAdapters, sessionTypeLabel } from '@aalis/api-platform';
import {
  isUnfiled,
  placeKind,
  placeLabel,
  rootSessionOf,
  type SessionInfo,
  type SessionKind,
  type SessionPlace,
} from '@aalis/api-session-manager';
import {
  type ActualValue,
  appliesIn,
  describeLayer,
  resolveFields,
  type SessionAt,
  type SessionChain,
  type SessionConfigDoc,
  type SessionFieldEntry,
  type SessionFieldRow,
  type SessionLayerName,
  type SessionPlacement,
  type SessionSettingsLayer,
  type SessionSettingsLayerInfo,
  type SessionSettingsService,
  sessionSettingsError,
} from '@aalis/api-session-settings';
import {
  type ConfigSchema,
  isSessionField,
  isUnsafeConfigKey,
  readFieldValue,
  type SchemaField,
  type SessionFieldSpec,
} from '@aalis/schema-config';
import type { Caps } from './caps.js';
import { SettingsEditor } from './commands.js';
import { type DocLayers, isLayerName, isRecord, putDocValue, readDoc, type Values } from './doc.js';
import { t } from './texts.js';

/** 会话与场所记录 metadata 里本插件的键 */
const KEY = 'session-settings';

/** 带标记的字段 */
export type Field = SchemaField & { session: SessionFieldSpec };

/** 一个实例的登记：schema、带标记字段的键（schema 键序）、读全局原样值的闭包与 actual */
interface Entry {
  plugin: string;
  schema: ConfigSchema;
  keys: string[];
  readGlobal: () => Values;
  actual: Readonly<Record<string, ActualValue>>;
}

/** 一个已登记的项 */
export interface Item {
  plugin: string;
  key: string;
  field: Field;
}

/**
 * 一处取全局之外的哪几层：有平台的取平台档，平台与类型都有的取平台类型档，有场所的取场所，有会话记录的取本会话层。会话见
 * contextOf；一层见 contextAt
 */
export interface SessionContext {
  session?: SessionInfo;
  kind?: SessionKind;
  platform?: string;
  type?: string;
  place?: SessionPlace;
}

const RANK = { composer: 0, common: 1, advanced: 2 } as const;
const COMPOSER_LIMIT = 2;

/** 会话设置的一条记录：会话与场所 metadata 里 values 数组的一项 */
interface Placed {
  plugin: string;
  key: string;
  value: unknown;
}

/** 去掉函数成员，经 JSON 下发 */
function wire(field: Field): SessionFieldRow['field'] {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(field)) if (typeof value !== 'function') out[name] = value;
  return out as SessionFieldRow['field'];
}

/** 平台类型档只有房间与房间的子会话会取 */
const forRooms = (field: Field) => appliesIn(field.session, 'room') || appliesIn(field.session, 'task');

export class SessionSettingsProvider implements SessionSettingsService {
  /** 实例 id → 登记，按登记先后 */
  private readonly entries = new Map<string, Entry>();
  private readonly warned = new Set<string>();
  /** 在聊天里看与改设置：指令与 setAs 共用 */
  readonly editor: SettingsEditor;

  constructor(private readonly caps: Caps) {
    this.editor = new SettingsEditor(this, caps);
  }

  private get sm() {
    return this.caps.sessionManager.use;
  }

  private warnOnce = (message: string): void => {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.caps.logger.use.warn(message);
  };

  /** 宿主文档以外的设置变了 */
  changed(): void {
    void this.caps.events.use.emit('session-settings:changed');
  }

  // ---- 登记 ----

  register(
    plugin: string,
    schema: ConfigSchema,
    readGlobal: () => Values,
    actual: Readonly<Record<string, ActualValue>>,
  ): () => void {
    const keys = Object.keys(schema).filter(key => isSessionField(schema[key]));
    const entry: Entry = { plugin, schema, keys, readGlobal, actual };
    this.entries.delete(plugin);
    this.entries.set(plugin, entry);
    this.changed();
    return () => {
      if (this.entries.get(plugin) !== entry) return;
      this.entries.delete(plugin);
      this.changed();
    };
  }

  getAll(): SessionFieldEntry[] {
    return this.items().map(({ plugin, key, field }) => ({
      plugin,
      key,
      label: field.label,
      ...(field.session.minLevel === undefined ? {} : { minLevel: field.session.minLevel }),
    }));
  }

  /** 已登记的各项：按登记先后与 schema 键序 */
  items(): Item[] {
    return [...this.entries.values()].flatMap(entry =>
      entry.keys.map(key => ({ plugin: entry.plugin, key, field: entry.schema[key] as Field })),
    );
  }

  // ---- 读 ----

  /**
   * 一处收哪些项（一组行与指令认项共用）：本会话收适用于会话种类（不在表里或空记录的没有种类，不筛）、不是只能设到场所的项；
   * 场所按场所种类收；平台类型档只收房间与子会话会取的；平台档与全局全收
   */
  acceptsAt(
    name: SessionLayerName,
    { kind, place }: Pick<SessionContext, 'kind' | 'place'>,
  ): (field: Field) => boolean {
    switch (name) {
      case 'session':
        return field => (kind === undefined || appliesIn(field.session, kind)) && field.session.narrowest === undefined;
      case 'place': {
        const where = place && placeKind(place);
        return field => where !== undefined && appliesIn(field.session, where);
      }
      case 'platformType':
        return forRooms;
      default:
        return () => true;
    }
  }

  /**
   * 一个会话取哪几层：子会话一律按根会话取平台、聊天窗口的类型与场所。不在表里的会话、根会话是空记录（或父会话链断了）的没有
   * 种类、类型与场所，平台取入口平台；有记录的另带本会话层
   */
  contextOf(sessionId: string, at: SessionAt = {}): SessionContext {
    const sm = this.sm;
    const session = sm.getSession(sessionId);
    const root = rootSessionOf(session, id => sm.getSession(id));
    if (!session || !root || isUnfiled(root)) return { session, platform: at.platform };
    return {
      session,
      kind: session.kind,
      platform: root.originPlatform ?? at.platform,
      type: root.originChat?.type,
      place: sm.placeOf(sessionId),
    };
  }

  /**
   * 一层取哪几层：平台档只取平台档；平台类型档取平台档与平台类型档；窗口场所取平台档、平台类型档与场所，工作区场所只取场所；
   * 全局什么都不取。场所不存在、层不认识时抛错
   */
  private contextAt(layer: SessionSettingsLayer): SessionContext {
    switch (layer.scope) {
      case 'global':
        return {};
      case 'platform':
        return { platform: layer.platform };
      case 'platformType':
        return { platform: layer.platform, type: layer.type };
      case 'place': {
        const place = typeof layer.key === 'string' ? this.sm.getPlace(layer.key) : undefined;
        if (!place) throw sessionSettingsError(t('noPlace', { key: String(layer.key) }));
        const window = place.kind === 'window' ? parseWindowKey(place.key) : undefined;
        return { platform: window?.platform, type: window?.type, place };
      }
      default:
        throw sessionSettingsError(t('unknownLayer', { layer: String((layer as { scope?: unknown }).scope) }));
    }
  }

  /** 一处在全局之上的各层原样值（复制品），按层表先后 */
  private chainOf(
    plugin: string,
    doc: DocLayers,
    { session, kind, platform, type, place }: SessionContext,
  ): SessionChain {
    const parts: SessionChain['parts'] = [];
    const push = (layer: Exclude<SessionSettingsLayer, { scope: 'global' }>, values: Values | undefined) =>
      parts.push({ layer: layer.scope, where: describeLayer(layer), values: structuredClone(values ?? {}) });
    if (platform !== undefined) push({ scope: 'platform', platform }, doc.platforms.get(platform)?.get(plugin));
    if (platform !== undefined && type !== undefined) {
      push({ scope: 'platformType', platform, type }, doc.platformTypes.get(platform)?.get(type)?.get(plugin));
    }
    if (place) push({ scope: 'place', key: place.key }, this.placeValues(place.key).get(plugin));
    if (session) {
      parts.push({
        layer: 'session',
        where: `会话 ${session.id}`,
        values: structuredClone(this.sessionValues(session).get(plugin) ?? {}),
      });
    }
    return { kind, placeKind: place && placeKind(place), parts };
  }

  chain(plugin: string, sessionId: string, at?: SessionAt): SessionChain {
    return this.chainOf(plugin, this.readDoc(), this.contextOf(sessionId, at));
  }

  /** 宿主文档里的两层：没有文档时为空 */
  private readDoc(): DocLayers {
    const host = this.caps.hostConfig.present ? this.caps.hostConfig.use : undefined;
    let configured: ReadonlySet<string> | undefined;
    return readDoc(host?.get('sessionConfig'), {
      known: id => {
        if (this.entries.has(id)) return true;
        configured ??= new Set(Object.keys(host?.get('plugins') ?? {}));
        return configured.has(id);
      },
      warn: this.warnOnce,
    });
  }

  /** 记录里的值：values 不是数组、条目缺 plugin、key 或 value（value 为 null 也算缺）的按缺失处理，每条记录告警一次 */
  private recordValues(metadata: Record<string, unknown> | undefined, where: string): Map<string, Values> {
    const out = new Map<string, Values>();
    for (const { plugin, key, value } of this.recordEntries(metadata, where)) {
      out.set(plugin, { ...out.get(plugin), [key]: value });
    }
    return out;
  }

  private recordEntries(metadata: Record<string, unknown> | undefined, where: string): Placed[] {
    const own = metadata?.[KEY];
    if (own === undefined) return [];
    const values = isRecord(own) ? own.values : undefined;
    if (!Array.isArray(values)) {
      this.warnOnce(`${where} 上的会话设置记录形状不对（values 不是数组），按没设处理`);
      return [];
    }
    const entries = values.filter(
      (e): e is Placed =>
        isRecord(e) &&
        typeof e.plugin === 'string' &&
        typeof e.key === 'string' &&
        !isUnsafeConfigKey(e.key) &&
        e.value !== undefined &&
        e.value !== null,
    );
    if (entries.length < values.length) {
      this.warnOnce(`${where} 上的会话设置记录有条目缺 plugin、key 或 value，这些条目按没设处理`);
    }
    return entries;
  }

  private sessionValues(session: SessionInfo | undefined): Map<string, Values> {
    return session ? this.recordValues(session.metadata, `会话 ${session.id}`) : new Map();
  }

  private placeValues(key: string, record = this.sm.getPlace(key)): Map<string, Values> {
    return record ? this.recordValues(record.metadata, `场所 ${key}`) : new Map();
  }

  /** 全局层的原样值：插件配置里的，写了 preference 的项取声明它的插件的本插件偏好 */
  private globalOf(entry: Entry): Values {
    const global = entry.readGlobal();
    for (const key of entry.keys) {
      const field = entry.schema[key] as Field;
      const service = field.session.preference;
      if (service === undefined) continue;
      const contextId = this.caps.services.use.preferred(service, { for: entry.plugin });
      const value = contextId === undefined ? undefined : field.fromText?.(contextId);
      if (value !== undefined) global[key] = value;
    }
    return global;
  }

  placements(plugin: string): SessionPlacement[] {
    const entry = this.entries.get(plugin);
    const out: SessionPlacement[] = [];
    const add = (values: Values | undefined, at: SessionPlacement['at']) => {
      for (const [key, value] of Object.entries(values ?? {})) {
        if (!entry || entry.keys.includes(key)) out.push({ key, value, at });
      }
    };
    const doc = this.readDoc();
    for (const [platform, byInstance] of doc.platforms)
      add(byInstance.get(plugin), { layer: { scope: 'platform', platform } });
    for (const [platform, byType] of doc.platformTypes) {
      for (const [type, byInstance] of byType) {
        add(byInstance.get(plugin), { layer: { scope: 'platformType', platform, type } });
      }
    }
    for (const place of this.sm.listPlaces()) {
      add(this.placeValues(place.key, place).get(plugin), {
        layer: { scope: 'place', key: place.key },
        placeKind: placeKind(place),
      });
    }
    for (const session of this.sm.listSessions())
      add(this.sessionValues(session).get(plugin), { sessionId: session.id });
    return out;
  }

  layers(): SessionSettingsLayerInfo[] {
    const doc = this.readDoc();
    const adapters = getPlatformAdapters(this.caps.platform);
    const sorted = (names: Iterable<string>) => [...new Set(names)].filter(isLayerName).sort();
    const platforms = sorted([...adapters.map(a => a.platform), ...doc.platforms.keys(), ...doc.platformTypes.keys()]);
    const out: SessionSettingsLayerInfo[] = [{ layer: { scope: 'global' } }];
    for (const platform of platforms) out.push({ layer: { scope: 'platform', platform } });
    // 平台类型档：声明了显示名的带上它
    for (const platform of platforms) {
      const declared = adapters
        .filter(a => a.platform === platform)
        .flatMap(a => (a.sessionTypes ?? []).map(d => d.name));
      for (const type of sorted([...declared, ...(doc.platformTypes.get(platform)?.keys() ?? [])])) {
        const label = sessionTypeLabel(this.caps.platform, platform, type);
        out.push({ layer: { scope: 'platformType', platform, type }, ...(label === undefined ? {} : { label }) });
      }
    }
    // 场所：工作区在前（默认工作区最前），窗口在后。称呼不带平台：取了名的工作区写「工作区「名字」」，窗口写类型的显示名
    // （没声明时写类型名）与窗口名，另带平台与类型名
    const places = this.sm.listPlaces();
    for (const place of [...places.filter(p => p.kind === 'workspace'), ...places.filter(p => p.kind === 'window')]) {
      const layer = { scope: 'place', key: place.key } as const;
      const window = place.kind === 'window' ? parseWindowKey(place.key) : undefined;
      if (!window) {
        out.push({
          layer,
          label: place.name === undefined ? placeLabel(place) : t('workspacePlace', { name: place.name }),
        });
        continue;
      }
      const label = t('windowPlace', {
        type: sessionTypeLabel(this.caps.platform, window.platform, window.type) ?? window.type,
        name: placeLabel(place),
      });
      out.push({ layer, label, platform: window.platform, type: window.type });
    }
    return out;
  }

  /**
   * 一组行：会话的（只列适用于它的种类、不是只能设到场所的项）或一层的（只列在这一层可写的项），各带这一处自己的原样值与
   * 解析到这一处为止的生效值。窗口场所在全局、平台档、平台类型档之上，工作区场所只在全局之上，平台类型档在全局、平台档之上，
   * 平台档只在全局之上
   */
  rows(target: { sessionId: string; at?: SessionAt } | { layer: SessionSettingsLayer }): SessionFieldRow[] {
    const name = 'sessionId' in target ? 'session' : target.layer.scope;
    const ctx = 'sessionId' in target ? this.contextOf(target.sessionId, target.at) : this.contextAt(target.layer);
    const lists = this.acceptsAt(name, ctx);
    const sessionId = 'sessionId' in target ? target.sessionId : undefined;
    const at = 'sessionId' in target ? (target.at ?? {}) : { platform: ctx.platform };
    const doc = this.readDoc();
    const rows: Array<SessionFieldRow & { order?: number }> = [];
    for (const entry of this.entries.values()) {
      const global = this.globalOf(entry);
      const chain = this.chainOf(entry.plugin, doc, ctx);
      const own = name === 'global' ? global : (chain.parts.find(part => part.layer === name)?.values ?? {});
      const { values, sources } = resolveFields(entry.schema, global, chain, this.warnOnce);
      for (const key of entry.keys) {
        const field = entry.schema[key] as Field;
        if (!lists(field)) continue;
        const row: SessionFieldRow & { order?: number } = {
          plugin: entry.plugin,
          key,
          field: wire(field),
          prominence: field.session.prominence,
          order: field.session.order,
          value: own[key],
          effective: values[key],
          source: sources[key],
        };
        const actual = values[key] === undefined ? entry.actual[key]?.(sessionId, at) : undefined;
        if (actual) row.actual = actual;
        rows.push(row);
      }
    }
    const byProminence = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      RANK[a.prominence] - RANK[b.prominence] ||
      (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY);
    let composers = 0;
    return rows
      .sort(byProminence)
      .map(row =>
        row.prominence === 'composer' && ++composers > COMPOSER_LIMIT ? { ...row, prominence: 'common' as const } : row,
      )
      .sort(byProminence)
      .map(({ order: _order, ...row }) => row);
  }

  // ---- 写 ----

  async update(
    target: { sessionId: string } | { layer: SessionSettingsLayer },
    item: { plugin: string; key: string; value: unknown },
  ): Promise<{ saveError?: unknown }> {
    const { plugin, key, value } = item;
    const entry = this.entries.get(plugin);
    if (!entry) throw sessionSettingsError(t('notRegistered', { item: `${plugin}/${key}` }));
    if (!entry.keys.includes(key)) throw sessionSettingsError(t('notSessionField', { item: `${plugin}/${key}` }));
    const field = entry.schema[key] as Field;
    let stored: unknown = null;
    if (value !== null) {
      const read = readFieldValue(field, value);
      if ('invalid' in read) throw sessionSettingsError(t('invalidValue', { item: key, reason: read.invalid }));
      stored = read.value ?? null;
    }
    const result = await ('sessionId' in target
      ? this.writeSession(target.sessionId, plugin, key, field, stored)
      : this.writeLayer(target.layer, entry, key, field, stored));
    // 写成了才点名这一处：不认识的层由 writeLayer 拒收，到不了这里
    const where = 'sessionId' in target ? `会话 ${target.sessionId}` : describeLayer(target.layer);
    this.caps.logger.use.info(`会话设置已改：${where}（${plugin}/${key}）`);
    return result;
  }

  private async writeSession(
    sessionId: string,
    plugin: string,
    key: string,
    field: Field,
    stored: unknown,
  ): Promise<{ saveError?: unknown }> {
    const { session, kind } = this.contextOf(sessionId);
    if (!session) throw sessionSettingsError(t('noSession', { id: sessionId }));
    if (stored !== null) {
      if (field.session.narrowest === 'place') throw sessionSettingsError(t('placeOnly', { item: key }));
      if (kind !== undefined && !appliesIn(field.session, kind)) {
        throw sessionSettingsError(t('notApplicable', { item: key, kind }));
      }
    }
    const values = this.written(session.metadata, `会话 ${sessionId}`, plugin, key, stored);
    await this.sm.updateSession(sessionId, { metadata: { [KEY]: { values } } });
    this.changed();
    return {};
  }

  private async writeLayer(
    layer: SessionSettingsLayer,
    entry: Entry,
    key: string,
    field: Field,
    stored: unknown,
  ): Promise<{ saveError?: unknown }> {
    const { plugin } = entry;
    const assertName = (name: unknown) => {
      if (!isLayerName(name)) throw sessionSettingsError(t('badLayerName', { name: String(name) }));
    };
    const assertRooms = () => {
      if (stored !== null && !forRooms(field)) throw sessionSettingsError(t('notForRooms', { item: key }));
    };
    switch (layer.scope) {
      case 'global':
        return this.writeGlobal(entry, key, field, stored);
      case 'platform':
        assertName(layer.platform);
        return this.writeDoc(['platforms', layer.platform, plugin], key, stored);
      case 'platformType':
        assertName(layer.platform);
        assertName(layer.type);
        assertRooms();
        return this.writeDoc(['platformTypes', layer.platform, layer.type, plugin], key, stored);
      case 'place': {
        const record = typeof layer.key === 'string' ? this.sm.getPlace(layer.key) : undefined;
        if (!record) throw sessionSettingsError(t('noPlace', { key: String(layer.key) }));
        const kind = placeKind(record);
        if (stored !== null && !appliesIn(field.session, kind)) {
          throw sessionSettingsError(t('notApplicable', { item: key, kind }));
        }
        const values = this.written(record.metadata, `场所 ${layer.key}`, plugin, key, stored);
        await this.sm.updatePlace(layer.key, { metadata: { [KEY]: { values } } });
        this.changed();
        return {};
      }
      default:
        throw sessionSettingsError(t('unknownLayer', { layer: String((layer as { scope?: unknown }).scope) }));
    }
  }

  /** 记录里的值换掉这一项（stored 为 null 即删掉），不写 undefined；形状不对的条目不再写回 */
  private written(
    metadata: Record<string, unknown> | undefined,
    where: string,
    plugin: string,
    key: string,
    stored: unknown,
  ): Placed[] {
    const values = this.recordEntries(metadata, where).filter(e => e.plugin !== plugin || e.key !== key);
    return stored === null ? values : [...values, { plugin, key, value: stored }];
  }

  private host(): HostConfig {
    if (!this.caps.hostConfig.present) throw sessionSettingsError(t('noHostConfig'));
    return this.caps.hostConfig.use;
  }

  /** 落盘：失败不撤回（内存里的文档已生效），把原因交回 */
  private async save(host: HostConfig): Promise<{ saveError?: unknown }> {
    try {
      await host.save();
      return {};
    } catch (saveError) {
      return { saveError };
    }
  }

  /** 改文档里的一处的一项：在现读的原样文档上只改这一项，读不懂的部分原样留着；路径上的值不是对象时拒收 */
  private writeDoc(path: string[], key: string, stored: unknown): Promise<{ saveError?: unknown }> {
    const host = this.host();
    const written = putDocValue(host.get('sessionConfig'), path, key, stored);
    if ('notObject' in written) throw sessionSettingsError(t('notObject', { path: written.notObject }));
    host.set('sessionConfig', written.doc as SessionConfigDoc);
    return this.save(host);
  }

  /**
   * 全局层：普通字段在最新文档上只改这一个键（null 时有 default 写 default，没有就删掉），不经 applyPluginConfig、插件不重载；
   * 写了 preference 的字段改声明它的插件的本插件偏好（运行态与文档），contextId 要有提供者，null 即取消
   */
  private writeGlobal(entry: Entry, key: string, field: Field, stored: unknown): Promise<{ saveError?: unknown }> {
    const host = this.host();
    const service = field.session.preference;
    const scope = { for: entry.plugin };
    if (service === undefined) {
      const next = { ...host.getPluginConfig(entry.plugin) };
      if (stored !== null) next[key] = stored;
      else if (field.default !== undefined) next[key] = structuredClone(field.default);
      else delete next[key];
      host.setPluginConfig(entry.plugin, next);
    } else if (stored === null) {
      this.caps.services.use.unprefer(service, scope);
      host.removeServicePreference(service, scope);
    } else {
      const contextId = field.toText!(stored);
      if (!this.caps.services.use.inspect(service).some(info => info.contextId === contextId)) {
        throw sessionSettingsError(t('unknownProvider', { item: key, contextId, service }));
      }
      this.caps.services.use.prefer(service, contextId, scope);
      host.setServicePreference(service, contextId, scope);
    }
    return this.save(host);
  }

  setAs(identity: { platform: string; userId: string }, sessionId: string, item: string, text: string) {
    return this.editor.setAs(identity, sessionId, item, text);
  }

  // ---- 子会话 ----

  childMetadata(parentId: string, at: SessionAt = {}): Record<string, unknown> {
    const values: Placed[] = [];
    // 父会话的各层按子会话的种类解析
    const ctx: SessionContext = { ...this.contextOf(parentId, at), kind: 'task' };
    const doc = this.readDoc();
    for (const entry of this.entries.values()) {
      const chain = this.chainOf(entry.plugin, doc, ctx);
      const resolved = resolveFields(entry.schema, entry.readGlobal(), chain, this.warnOnce).values;
      for (const key of entry.keys) {
        const field = entry.schema[key] as Field;
        if (!appliesIn(field.session, 'task') || field.session.narrowest !== undefined) continue;
        if (Object.hasOwn(resolved, key)) {
          values.push({ plugin: entry.plugin, key, value: resolved[key] });
          continue;
        }
        const actual = entry.actual[key]?.(parentId, at);
        const read = actual && readFieldValue(field, actual.value);
        if (read && !('invalid' in read) && read.value !== undefined) {
          values.push({ plugin: entry.plugin, key, value: read.value });
        }
      }
    }
    // 父会话自己那一层里此刻没登记的实例（重载中、停用、出错或卸载后留下的）原样带上
    const parent = this.sm.getSession(parentId);
    if (parent) {
      for (const placed of this.recordEntries(parent.metadata, `会话 ${parentId}`)) {
        if (!this.entries.has(placed.plugin)) values.push(placed);
      }
    }
    return { [KEY]: { values } };
  }
}

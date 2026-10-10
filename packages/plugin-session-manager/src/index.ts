import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { agent } from '@aalis/api-agent';
import { authority } from '@aalis/api-authority';
import { chatScopeOf, parseWindowKey, windowKey } from '@aalis/api-gateway';
import { type HookContextMap, hooks } from '@aalis/api-hooks';
import { type HostConfig, hostConfig } from '@aalis/api-host-config';
import { type LLMUsageEvent, lightestThinking, llm, type ModelRef, resolveLLMModel } from '@aalis/api-llm';
import { type MemoryService, type MetadataOp, memory } from '@aalis/api-memory';
import {
  claimantsOf,
  getPlatformAdapters,
  platform,
  resolvePlatformBySession,
  sessionTypesOf,
} from '@aalis/api-platform';
import {
  type InheritanceSource,
  type NewSessionFields,
  type OriginChat,
  type PlaceInfo,
  type RegisteredSessionSetting,
  rootSessionOf,
  SESSION_LAYERS,
  type SessionConfig,
  SessionConfigError,
  type SessionConfigLayer,
  type SessionConfigPatch,
  type SessionCreation,
  type SessionInfo,
  type SessionInheritance,
  type SessionLayerName,
  type SessionManagerService,
  type SessionPlace,
  type SessionSetting,
  type SessionUpdates,
  sessionKind,
  sessionManager,
  type WorkBinding,
  type WorkspaceInfo,
} from '@aalis/api-session-manager';
import { type BoundOf, definePlugin, events, lifecycle, logger, optional, provide, services } from '@aalis/core';
import type { IncomingMessage, Message } from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';
import {
  applyPatch,
  assertName,
  assertSessionPatch,
  checkPatch,
  type DocLayers,
  isLayerName,
  readLayers,
  readSetting,
  SettingRegistry,
  type SettingValues,
  writeLayers,
} from './settings.js';

// ===== 常量 =====

/** 会话表与场所记录在记忆后端元数据里的命名空间 */
const SESSIONS = 'sessions';
const PLACES = 'places';
/** 必填字段不对、没有载入的记录移到 `<命名空间>-rejected`：留在原处会被之后同键的建档整条覆盖 */
const REJECTED_SUFFIX = '-rejected';
/** 工作区的场所键前缀；默认工作区的 id 为 default */
const WORKSPACE_PREFIX = 'workspace:';
const DEFAULT_WORKSPACE = 'default';
const DEFAULT_PLACE: SessionPlace = Object.freeze({
  kind: 'workspace',
  key: `${WORKSPACE_PREFIX}${DEFAULT_WORKSPACE}`,
});
/** 读会话表失败后的重试间隔（毫秒）；用尽仍失败按读表失败处理 */
const LOAD_RETRY_DELAYS = [1000, 3000, 10_000];
/** 最近一轮出错原因最多留多少字 */
const ERROR_MAX = 200;

// ===== 辅助函数 =====

/** 等待 ms 毫秒，signal 中止时提前返回。不用 node:timers/promises：全局定时器测试里能用假时钟推进 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

// ===== SessionManager 实现 =====

/**
 * SessionManager 用到的能力：落盘的 memory、会话事件、memory:clear 钩子、标题生成的 LLM、中止读表重试的 lifecycle，
 * 解析接管房间的适配器实例的 platform，存放会话设置三层的宿主配置文档，判 owner 的 IM 私聊的 authority，
 * 以及承担全局默认模型的服务偏好
 */
type ManagerCaps = Pick<
  Caps,
  'memory' | 'events' | 'hooks' | 'logger' | 'llm' | 'lifecycle' | 'platform' | 'hostConfig' | 'authority' | 'services'
>;

/** 回合的结局（api-agent 的 agent:turn:after） */
type TurnOutcome = HookContextMap['agent:turn:after']['outcome'];

/** IM 房间收录按原生入站记下的来源字段，与收录之前解析到的接管它的适配器实例（没有适配器认领时不带） */
type RoomOrigin = Required<Pick<SessionInfo, 'originPlatform' | 'originChat'>> & Pick<SessionInfo, 'originInstance'>;

/** 场所记录：显示名、项目工作区的目录，与这个场所对各设置项的值（与层同一套校验，没登记的键原样保留） */
interface PlaceRecord extends PlaceInfo {
  /** 目录的真实路径：只有项目工作区带 */
  root?: string;
  config: SettingValues;
  createdAt: number;
  updatedAt: number;
}

/** 存在记忆后端元数据里的两张表 */
type Table = typeof SESSIONS | typeof PLACES;

type ConfigScope = SessionConfigLayer['scope'];
type LayerOf<S extends ConfigScope> = Extract<SessionConfigLayer, { scope: S }>;

/** 选层的依据：一个会话的（子会话按根会话），或一层的视图在哪些层之上 */
interface LayerContext {
  platform?: string;
  type?: string;
  place?: SessionPlace;
  /** 父会话：它的 sessionDefaults（旧数据）是父会话层 */
  parent?: SessionInfo;
}

/**
 * 会话之上一层的实现：在一个会话上取哪一份（不适用时为 undefined）、层标识的校验、存在哪（读与整份写）、可设的各份、
 * 日志里的称呼，以及这一层的视图在哪些层之上
 */
interface LayerImpl<L extends SessionConfigLayer> {
  select(ctx: LayerContext): L | undefined;
  assert(layer: L): void;
  read(layer: L): SettingValues | undefined;
  write(layer: L, values: SettingValues): Promise<void>;
  list(): L[];
  describe(layer: L): string;
  context(layer: L): LayerContext;
}

/** 继承链的一段：一处设置的原样值、来源层、日志里的称呼 */
type Part = [values: object | undefined, source: InheritanceSource, where: string];

/** 层表里这一层的称呼，日志里点名层时用 */
const layerLabel = (name: SessionLayerName): string => SESSION_LAYERS.find(layer => layer.name === name)!.label;

/** 全局默认层由服务偏好承担的项：字段类型为 llm-ref（选 llm 服务的提供者）的设置项，读写 llm 服务的偏好 */
const preferenceBacked = (setting: SessionSetting): boolean => setting.field.type === 'llm-ref';

class SessionManager implements SessionManagerService {
  private sessions = new Map<string, SessionInfo>();
  /** 场所记录：键 → 记录。与会话表一同加载与落盘 */
  private places = new Map<string, PlaceRecord>();
  private caps: ManagerCaps;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /**
   * 本进程显式删除、尚未落盘的记录（墓碑），按表分开。persist 写全量快照，但只删这些键，不按「后端有、内存无」清扫：
   * 后端里还可能有本进程没读到的记录，按差集清扫会把它们当孤儿删掉。每条墓碑带令牌，提交成功后只清掉
   * 提交时那一版，提交期间再删的保留到下一次。换后端时墓碑随旧表一起作废。
   */
  private deleted: Record<Table, Map<string, symbol>> = { [SESSIONS]: new Map(), [PLACES]: new Map() };
  /**
   * 会话表所在的 memory 实例：跟随 memory 胜者。换人时先把旧表的未落盘变更写回旧实例，再从新实例读表整体替换
   * （换后端即换库，不跨后端合并）。新表加载完成前仍指向旧实例，落盘不会把旧表写进新后端；加载窗口里的改动
   * 在换表时写回旧实例。读表失败时为 undefined：空表不能当作权威，否则落盘会用新建的空白记录覆盖后端原记录。
   */
  private store: MemoryService | undefined;
  /** 最近一次挂接的加载；apply 等它完成再对外提供服务 */
  loading: Promise<void> = Promise.resolve();
  /** 插件登记的设置项：登记与撤回都发 session:config:changed */
  private readonly settings = new SettingRegistry(() => void this.caps.events.emit('session:config:changed'));
  /** 已告警过的设置问题：取值无效、文档形状不对。解析每轮都跑，同一处只告警一次 */
  private readonly warned = new Set<string>();
  /**
   * 在飞的回合：turnId → 所在会话与这一轮的结局（出错时带原因）。agent:input:before 进出登记与注销，结局由
   * agent:turn:after 记下（消息被拦下的一轮不发它，没有结局）。同一会话按 lane 可以并行多轮（后台任务结束通知、白纸通知
   * 与真人回合），会话在最后一轮结束时才收口；回合之外建档的会话按这里有没有回合定初始状态（见 ensureSession）
   */
  private turns = new Map<string, { sessionId: string; outcome?: TurnOutcome; error?: string }>();
  /** 正在解析所属实例的会话记录：同一条记录不并发解析，后到的调用不等它、直接返回 */
  private resolving = new WeakSet<SessionInfo>();
  private readonly lookup = (id: string) => this.sessions.get(id);

  /** 层表的实现：一层一条，继承链、按层读写与可设的层都遍历它（先后取自 SESSION_LAYERS） */
  private readonly layerTable: { [S in ConfigScope]: LayerImpl<LayerOf<S>> } = {
    defaults: {
      select: () => ({ scope: 'defaults' }),
      assert: () => {},
      read: () => this.readDefaults(),
      write: (_layer, values) => this.writeDefaults(values),
      list: () => [{ scope: 'defaults' }],
      describe: () => layerLabel('defaults'),
      context: () => ({}),
    },
    platform: {
      select: ({ platform }) => (platform === undefined ? undefined : { scope: 'platform', platform }),
      assert: layer => assertName('平台名', layer.platform),
      read: layer => this.docLayers().platforms.get(layer.platform),
      write: (layer, values) => this.writeDoc(doc => doc.platforms.set(layer.platform, values)),
      list: () => this.platformNames().map(platform => ({ scope: 'platform', platform })),
      describe: layer => `${layerLabel('platform')} ${layer.platform}`,
      context: ({ platform }) => ({ platform }),
    },
    type: {
      select: ({ platform, type }) =>
        platform === undefined || type === undefined ? undefined : { scope: 'type', platform, type },
      assert: layer => {
        assertName('平台名', layer.platform);
        assertName('类型名', layer.type);
      },
      read: layer => this.docLayers().types.get(layer.platform)?.get(layer.type),
      write: (layer, values) =>
        this.writeDoc(doc =>
          doc.types.set(layer.platform, new Map(doc.types.get(layer.platform)).set(layer.type, values)),
        ),
      list: () =>
        this.platformNames().flatMap(platform =>
          this.typeNames(platform).map(type => ({ scope: 'type' as const, platform, type })),
        ),
      describe: layer => `${layerLabel('type')} ${layer.platform} · ${layer.type}`,
      context: ({ platform, type }) => ({ platform, type }),
    },
    place: {
      select: ({ place }) => place && { scope: 'place', key: place.key },
      assert: layer => {
        if (typeof layer.key !== 'string' || !this.places.has(layer.key)) {
          throw new SessionConfigError(`场所不存在：${String(layer.key)}`);
        }
      },
      read: layer => this.places.get(layer.key)?.config,
      write: async (layer, values) => {
        const record = this.places.get(layer.key)!;
        record.config = values;
        record.updatedAt = Date.now();
        this.markDirty();
      },
      list: () =>
        [...this.places.keys()]
          .sort()
          .sort(defaultFirst)
          .map(key => ({ scope: 'place', key })),
      describe: layer => `${layerLabel('place')} ${layer.key}`,
      context: layer => {
        const { kind, key } = this.places.get(layer.key)!;
        const window = kind === 'window' ? parseWindowKey(key) : undefined;
        return { platform: window?.platform, type: window?.type, place: { kind, key } };
      },
    },
  };

  constructor(caps: ManagerCaps) {
    this.caps = caps;
  }

  /**
   * 消息历史类操作（清空、读历史）用当前胜者：新消息写在当前胜者里。每次惰性查询，provider 切换后自然跟随。
   * 会话表另经 {@link store} 跟随，见 {@link attach}。
   */
  private get memory(): MemoryService {
    const m = this.caps.memory.current;
    if (!m) throw new Error('session-manager 需要 memory 服务');
    return m;
  }

  /**
   * memory 胜者的 follow 挂接：从这个实例读会话表与场所记录，整体替换内存里的这份。
   * 返回的清理在换人或关闭时执行：中止读表重试的等待，等本次加载落定，再把未落盘的变更写回这个实例。
   */
  attach(instance: MemoryService): () => Promise<void> {
    const detached = new AbortController();
    this.loading = this.load(instance, AbortSignal.any([detached.signal, this.caps.lifecycle.signal]));
    return async () => {
      detached.abort();
      await this.loading;
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      await this.persist().catch(err => this.caps.logger.warn('换后端前落盘会话失败:', err));
    };
  }

  /**
   * 从 memory 元数据加载会话表与场所记录，加载完成后以它们为准、以这个实例为落盘目标。读表失败按 {@link LOAD_RETRY_DELAYS}
   * 有限重试，其间仍用原来的表与落盘目标；用尽或被中止（换人、停机）时两张表为空且不落盘。默认工作区的记录不在时补上
   * （随下一次落盘写进后端）。
   */
  private async load(instance: MemoryService, signal: AbortSignal): Promise<void> {
    let loaded: { sessions: Map<string, SessionInfo>; places: Map<string, PlaceRecord> } | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        loaded = {
          sessions: await this.readTable(instance, SESSIONS, '会话记录', (key, data) => {
            const read = storedSession(key, data);
            return 'wrong' in read
              ? read
              : { record: { ...read.record, ...describeSession(read.record) }, dropped: read.dropped };
          }),
          places: await this.readTable(instance, PLACES, '场所记录', storedPlace),
        };
        break;
      } catch (err) {
        const delay = LOAD_RETRY_DELAYS[attempt];
        if (delay !== undefined && !signal.aborted) {
          this.caps.logger.warn(`加载会话数据失败，${delay}ms 后重试:`, err);
          await wait(delay, signal);
          if (!signal.aborted) continue;
        }
        if (signal.aborted) this.caps.logger.info('已中止加载会话数据（停用、停机或换后端）');
        else this.caps.logger.error('加载会话数据失败，在这个后端上的会话改动不落盘（以免覆盖原有记录）:', err);
        break;
      }
    }
    // 加载窗口里旧表的改动：落盘目标此前仍是旧实例，换表前取快照，换表后写回
    const previous = this.store;
    const pending = previous && this.dirty ? this.snapshot().ops : undefined;
    this.sessions = loaded?.sessions ?? new Map();
    this.places = loaded?.places ?? new Map();
    if (!this.places.has(DEFAULT_PLACE.key)) this.places.set(DEFAULT_PLACE.key, newPlace(DEFAULT_PLACE, '默认工作区'));
    this.deleted = { [SESSIONS]: new Map(), [PLACES]: new Map() };
    this.dirty = false;
    this.store = loaded ? instance : undefined;
    if (loaded) this.caps.logger.info(`已加载 ${loaded.sessions.size} 个会话、${loaded.places.size} 个场所`);
    if (previous && pending)
      await previous.commitMetadata(pending).catch(err => this.caps.logger.warn('换后端时写回旧后端失败:', err));
  }

  /**
   * 读一张表：必填字段不对的记录不载入，移到 `<命名空间>-rejected`（先写副本再删原处：后端不保证整批原子时，停在半途也
   * 不丢记录）；可选字段类型不对的去掉这些字段照常载入。两种都告警
   */
  private async readTable<T>(
    instance: MemoryService,
    namespace: Table,
    label: string,
    parse: (key: string, data: Record<string, unknown>) => { record: T; dropped: string[] } | { wrong: string },
  ): Promise<Map<string, T>> {
    const rows = new Map<string, T>();
    const dropped: string[] = [];
    const rejected: Array<{ key: string; data: Record<string, unknown>; field: string }> = [];
    for (const { key, data } of await instance.listMetadata(namespace)) {
      const read = parse(key, data);
      if ('wrong' in read) {
        rejected.push({ key, data, field: read.wrong });
        continue;
      }
      if (read.dropped.length > 0) dropped.push(`${key}（${read.dropped.join('、')}）`);
      rows.set(key, read.record);
    }
    const aside = `${namespace}${REJECTED_SUFFIX}`;
    if (rejected.length > 0) {
      await instance.commitMetadata(
        rejected.flatMap(({ key, data }): MetadataOp[] => [
          { op: 'put', namespace: aside, key, data },
          { op: 'del', namespace, key },
        ]),
      );
      this.caps.logger.warn(
        `${label}的必填字段不对，没有载入，原记录已移到 metadata 命名空间 ${aside}：` +
          rejected.map(({ key, field }) => `${key}（${field}）`).join('、'),
      );
    }
    if (dropped.length > 0)
      this.caps.logger.warn(`${label}有字段类型不对，去掉这些字段后照常载入：${dropped.join('、')}`);
    return rows;
  }

  /** 标记需要持久化并延迟刷盘 */
  private markDirty(): void {
    this.dirty = true;
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.persist().catch(err => this.caps.logger.warn('持久化会话失败:', err));
      }, 1000);
    }
  }

  /**
   * 持久化到 memory metadata —— **一次批量提交**。
   *
   * 逐条 saveMetadata + 全表扫逐个 deleteMetadata 的写法配上开头就置 false 的 `dirty`：
   * 任何一条抛错就停在半新半旧，且下一次 debounce 不会重试。
   *
   * 整批提交的**原子性按后端分档**（见 api-memory 契约）：sqlite/inmemory 真事务，
   * mongodb 只保证按序执行遇错即停，仍可能停在半新半旧。本场景对此免疫，靠的不是原子性
   * 而是**幂等 + 可重试**：每次写的是全量快照（不是增量），删除只针对墓碑；失败时 dirty 复位、
   * 墓碑保留，下一次 markDirty 会把完整状态重写一遍，前一次的半成品被整体覆盖。
   */
  async persist(): Promise<void> {
    const target = this.store;
    if (!this.dirty || !target) return;
    this.dirty = false;

    const { ops, tombstones } = this.snapshot();
    try {
      // 写入目标取落盘开始时的会话表所在实例：换人窗口里当前胜者可能已是新后端，旧表不能写过去
      await target.commitMetadata(ops);
      for (const [table, key, token] of tombstones) {
        if (this.deleted[table].get(key) === token) this.deleted[table].delete(key);
      }
    } catch (err) {
      this.dirty = true; // 失败要能重试，否则这批变更永远落不了盘
      throw err;
    }
  }

  /** 两张表的全量快照：每条记录一条 put，墓碑各一条 del */
  private snapshot(): { ops: MetadataOp[]; tombstones: Array<[Table, string, symbol]> } {
    const ops: MetadataOp[] = [];
    const tombstones: Array<[Table, string, symbol]> = [];
    for (const [namespace, rows] of [
      [SESSIONS, this.sessions],
      [PLACES, this.places],
    ] as const) {
      for (const [key, data] of rows) {
        ops.push({ op: 'put', namespace, key, data: data as unknown as Record<string, unknown> });
      }
      for (const [key, token] of this.deleted[namespace]) {
        tombstones.push([namespace, key, token]);
        if (!rows.has(key)) ops.push({ op: 'del', namespace, key });
      }
    }
    return { ops, tombstones };
  }

  /**
   * 按精确 id 幂等 upsert：命中走 updateSession（合并 config + emit `session:updated`），未命中以传入 id 建档。
   * 创建来源在建档时写；命中按 id 兜底建档留下的空记录（没有创建来源、出生平台与绑定）时补写，随这次更新落盘。
   * 终端配置的会话 id、/session.set 落配置覆盖时用
   */
  async ensureSession(
    id: string,
    patch: SessionUpdates = {},
    creation?: Pick<SessionCreation, 'createdFrom'>,
  ): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (!session) return this.insert(id, patch, creation ? { createdFrom: creation.createdFrom } : {});
    if (creation && !session.createdFrom && !session.originPlatform && !session.work) {
      session.createdFrom = creation.createdFrom;
    }
    return this.updateSession(id, patch);
  }

  /**
   * IM 房间收录：按原生入站记下的出生平台与聊天窗口建档，名字取出生平台给的群名或昵称（没有时为 id）。只给会话表里
   * 还没有的 id 同步调用。场所是窗口的同时确保窗口的场所记录：insert 在第一次等待之前已同步占住 id、记下来源字段
   */
  async recordRoom(id: string, nativeName: string | undefined, origin: RoomOrigin): Promise<SessionInfo> {
    const [created] = await Promise.all([
      this.insert(id, { name: nativeName || id, status: 'waiting' }, origin),
      this.noteWindow(id, nativeName),
    ]);
    return created;
  }

  /**
   * IM 房间收录的补记：按 id 兜底建档的根会话（没有来源字段、创建来源与绑定）与升级前只记了出生平台的记录（没有聊天窗口，
   * 出生平台与消息平台相同）收到原生入站时，记下与按这条消息建档时一样的来源字段，名字还是 id 的一并补上，场所是窗口的
   * 确保窗口的场所记录。只给表里这条记录同步调用，由收录监听判定这个 id 归消息平台的适配器管
   */
  async backfillRoom(session: SessionInfo, nativeName: string | undefined, origin: RoomOrigin): Promise<void> {
    Object.assign(session, origin, session.name === session.id && nativeName ? { name: nativeName } : {});
    Object.assign(session, describeSession(session));
    await this.noteWindow(session.id, nativeName);
    this.markDirty();
    await this.caps.events.emit('session:updated', session);
  }

  /**
   * 原生入站之后的窗口场所记录：会话的场所是窗口时，没有记录就建（显示名取出生平台给的名字，没有时为场所键），有记录而
   * 名字变了就跟着改。场所是工作区的（owner 的 IM 私聊）不建。建了或改了名，给场所是这个窗口的根会话各发一次
   * session:updated：会话的摘要在生成时取场所的显示名，不说话的群改了名也要刷新
   */
  async noteWindow(sessionId: string, nativeName: string | undefined): Promise<void> {
    const place = this.placeOf(sessionId);
    if (place.kind !== 'window') return;
    const record = this.places.get(place.key);
    if (!record) {
      this.places.set(place.key, newPlace(place, nativeName || place.key));
    } else if (nativeName && record.name !== nativeName) {
      record.name = nativeName;
      record.updatedAt = Date.now();
    } else return;
    this.markDirty();
    for (const session of [...this.sessions.values()]) {
      if (!session.parentId && this.placeOf(session.id).key === place.key) {
        await this.caps.events.emit('session:updated', session);
      }
    }
  }

  /**
   * 以传入 id 建档（emit `session:created`），fields 是只在建档时写的字段。状态缺省按有没有回合在跑：有为 active
   * （回合结束时收口），没有为 waiting（指令回复等回合之外的出站不改状态，建成 active 就会一直停在进行中）
   */
  private async insert(
    id: string,
    patch: SessionUpdates,
    fields: Pick<SessionInfo, 'createdFrom' | 'originPlatform' | 'originChat' | 'originInstance'>,
  ): Promise<SessionInfo> {
    const config = this.checkedConfig(patch.config);
    const now = Date.now();
    const session: SessionInfo = {
      id,
      name:
        patch.name ||
        `会话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      title: patch.metadata?.title as string | undefined,
      parentId: undefined,
      children: [],
      status: patch.status || (this.hasTurnInFlight(id) ? 'active' : 'waiting'),
      config,
      createdAt: now,
      updatedAt: now,
      inputContext: patch.metadata?.inputContext as string | undefined,
      metadata: patch.metadata,
      ...fields,
      ...describeSession(fields),
    };
    this.sessions.set(id, session);
    this.markDirty();
    await this.caps.events.emit('session:created', session);
    this.caps.logger.info(`会话建档(ensure): ${session.name} (${id})`);
    return session;
  }

  /**
   * 有出生平台的房间还没记下接管它的适配器实例时，解析并记下，会话列表按它分组；已记下的不改，子任务与 owner 面
   * 会话不记。收录与补记时实例随来源字段一起记下（收录之前已解析）；收录时没有适配器认领（适配器没装好、连接还没上来、
   * 账号暂时不属于任何实例）的房间与读表读进来的旧房间，由之后的真人入站调它补记。解析期间会话被删除或换表的不再写回，
   * 同一条记录的解析不并发。不会拒绝。
   */
  async recordOriginInstance(session: SessionInfo): Promise<void> {
    if (session.kind !== 'room' || session.originInstance || this.resolving.has(session)) return;
    this.resolving.add(session);
    try {
      const entry = await resolvePlatformBySession(this.caps.platform, session.id, this.caps.logger);
      if (!entry || this.sessions.get(session.id) !== session) return;
      session.originInstance = entry.contextId;
      this.markDirty();
      await this.caps.events.emit('session:updated', session);
    } finally {
      this.resolving.delete(session);
    }
  }

  // ---- CRUD ----

  async createSession(opts?: NewSessionFields, creation?: SessionCreation): Promise<SessionInfo> {
    if (creation && opts?.parentId)
      throw new Error('建档专用参数只给根会话：子会话按根会话取创建来源、所属工作区与绑定');
    const created = creation ? this.creationFields(creation) : {};
    const config = this.checkedConfig(opts?.config);
    const id = opts?.parentId
      ? `${opts.parentId}::${crypto.randomUUID().slice(0, 8)}`
      : `session-${crypto.randomUUID().slice(0, 8)}`;
    const parent = opts?.parentId ? this.sessions.get(opts.parentId) : undefined;

    const now = Date.now();
    const session: SessionInfo = {
      id,
      name:
        opts?.name ||
        `会话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      title: opts?.metadata?.title as string | undefined,
      parentId: opts?.parentId,
      children: [],
      status: opts?.status || 'active',
      config,
      createdAt: now,
      updatedAt: now,
      inputContext: opts?.inputContext ?? (opts?.metadata?.inputContext as string | undefined),
      metadata: opts?.metadata,
      ...created,
      // 子会话的当前目录取父会话此刻的值，之后各改各的
      ...(parent?.currentDir === undefined ? {} : { currentDir: parent.currentDir }),
      ...describeSession({ parentId: opts?.parentId }),
    };

    this.sessions.set(id, session);

    // 挂到父会话的 children 下：父会话的子会话列表变了，建档之后再给它发一次 session:updated
    if (parent) {
      parent.children.push(id);
      parent.updatedAt = now;
    }

    this.markDirty();
    await this.caps.events.emit('session:created', session);
    if (parent) await this.caps.events.emit('session:updated', parent);
    this.caps.logger.info(`会话创建: ${session.name} (${id})`);
    return session;
  }

  /**
   * 建档专用参数落成会话字段：工作区要有记录，项目工作区（有目录的）要带绑定，没有目录的不收绑定；默认工作区不记
   * （缺省即默认工作区）。建档不写当前目录：没有值即场所的主目录
   */
  private creationFields({
    createdFrom,
    workspace = DEFAULT_WORKSPACE,
    work,
  }: SessionCreation): Pick<SessionInfo, 'createdFrom' | 'workspace' | 'work'> {
    const record = this.places.get(`${WORKSPACE_PREFIX}${workspace}`);
    if (!record) throw new Error(`工作区不存在：${workspace}`);
    if (record.root !== undefined && !work) throw new Error(`在项目工作区里建会话要带绑定目录：${workspace}`);
    if (record.root === undefined && work) throw new Error(`绑定目录只给项目工作区里的会话：${workspace}`);
    return {
      createdFrom,
      ...(workspace === DEFAULT_WORKSPACE ? {} : { workspace }),
      ...(work ? { work: { root: work.root, extraRoots: [], worktrees: [] } } : {}),
    };
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[] {
    let result = [...this.sessions.values()];
    if (filter) {
      if (filter.parentId !== undefined) {
        if (filter.parentId === null) {
          result = result.filter(s => !s.parentId);
        } else {
          result = result.filter(s => s.parentId === filter.parentId);
        }
      }
      if (filter.status) {
        result = result.filter(s => s.status === filter.status);
      }
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async updateSession(id: string, updates: SessionUpdates): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    // 先校验再动记录：配置被拒时什么都不改
    const config = updates.config && this.checkedPatch(updates.config);

    if (updates.name !== undefined) session.name = updates.name;
    if (updates.status !== undefined) session.status = updates.status;
    if (updates.metadata !== undefined) session.metadata = { ...session.metadata, ...updates.metadata };
    if (config) session.config = applyPatch(session.config, config);
    session.updatedAt = Date.now();

    this.markDirty();
    await this.caps.events.emit('session:updated', session);
    if (config) await this.caps.events.emit('session:config:changed');
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    // 递归删除所有子会话（含活跃子会话）
    for (const childId of [...session.children]) {
      await this.deleteSession(childId);
    }

    // 从父会话的 children 中移除：父会话的子会话列表变了，删除之后再给它发一次 session:updated
    const parent = session.parentId ? this.sessions.get(session.parentId) : undefined;
    if (parent) {
      parent.children = parent.children.filter(c => c !== id);
      parent.updatedAt = Date.now();
    }

    this.sessions.delete(id);
    this.deleted[SESSIONS].set(id, Symbol(id));

    await this.clearDeletedSessionData(id);

    this.markDirty();
    await this.caps.events.emit('session:deleted', id);
    if (parent) await this.caps.events.emit('session:updated', parent);
    this.caps.logger.info(`会话删除: ${session.name} (${id})`);
  }

  private async clearDeletedSessionData(id: string): Promise<void> {
    const clearData: HookContextMap['memory:clear'] = {
      scope: 'session',
      sessionId: id,
      results: [],
    };

    await this.caps.hooks.run('memory:clear', clearData, async () => {
      try {
        await this.memory.clearSession(id);
        clearData.results.push({ source: 'memory', success: true, message: '会话消息历史已清空' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clearData.results.push({ source: 'memory', success: false, message: `会话消息历史清空失败: ${msg}` });
      }
    });

    const failed = clearData.results.filter(r => !r.success);
    if (failed.length > 0) {
      this.caps.logger.warn(
        `会话数据清理存在失败项 [${id}]: ${failed.map(r => `${r.source}: ${r.message}`).join('; ')}`,
      );
    }
  }

  // ---- 树形操作 ----

  async createChildSession(parentId: string, opts?: Omit<NewSessionFields, 'parentId'>): Promise<SessionInfo> {
    // 带 source 的注入回合（定时任务、编排）可能落在还没建档的会话上：先按 id 兜底建档再挂子会话，否则 create_subtask
    // 在这些会话里必败。兜底建档的会话没有来源字段与创建来源，名字为 id：是房间的由之后的原生入站补记来源字段与名字
    if (!this.sessions.has(parentId)) await this.ensureSession(parentId, { name: parentId });
    return this.createSession({ ...opts, parentId });
  }

  getChildren(parentId: string): SessionInfo[] {
    return this.listSessions({ parentId });
  }

  // ---- 当前目录与项目会话的绑定 ----

  async setCurrentDir(sessionId: string, dir: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    session.currentDir = dir;
    this.markDirty();
    await this.caps.events.emit('session:updated', session);
  }

  async setExtraRoots(sessionId: string, extraRoots: readonly string[]): Promise<void> {
    const { root, work } = this.inWorkTree(sessionId);
    work.extraRoots = [...extraRoots];
    this.markDirty();
    await this.caps.events.emit('session:updated', root);
  }

  async addWorktree(sessionId: string, path: string): Promise<void> {
    const { root, work } = this.inWorkTree(sessionId);
    if (work.worktrees.includes(path)) return;
    work.worktrees.push(path);
    this.markDirty();
    await this.caps.events.emit('session:updated', root);
  }

  /** 项目会话树的根会话与它的绑定；会话不存在或不在项目会话树里时抛错 */
  private inWorkTree(sessionId: string): { root: SessionInfo; work: WorkBinding } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    const root = rootSessionOf(session, this.lookup);
    if (!root?.work) throw new Error(`会话 ${sessionId} 不在项目会话里：根会话没有绑定目录`);
    return { root, work: root.work };
  }

  // ---- 场所与工作区 ----

  placeOf(sessionId: string): SessionPlace {
    const root = rootSessionOf(this.sessions.get(sessionId), this.lookup);
    if (root?.originPlatform !== undefined) {
      const chat = root.originChat;
      const targetId = chat?.targetId ?? '';
      // owner 的 IM 私聊是默认工作区的入口；没有 authority 时认不出 owner，按窗口算（与房间类别的失败关闭同向）
      const owner =
        targetId !== '' && !chat?.multiParty && this.caps.authority.current?.isOwner(root.originPlatform, targetId);
      if (owner) return DEFAULT_PLACE;
      const key = windowKey({ platform: root.originPlatform, type: chat?.type ?? '', targetId });
      // 聊天窗口缺失或没有目标的坏数据同样是窗口：落进默认工作区会把 owner 给工作区设的值套到房间上
      if (targetId === '') this.warnOnce(`会话 ${root.id} 有出生平台却没有聊天窗口或目标，按窗口 ${key} 算`);
      return { kind: 'window', key };
    }
    if (root?.workspace === undefined) return DEFAULT_PLACE;
    const key = `${WORKSPACE_PREFIX}${root.workspace}`;
    if (this.places.has(key)) return { kind: 'workspace', key };
    this.warnOnce(`会话 ${root.id} 记下的工作区 ${root.workspace} 没有记录，按默认工作区`);
    return DEFAULT_PLACE;
  }

  getPlace(key: string): PlaceInfo | undefined {
    const record = this.places.get(key);
    return record && placeInfo(record);
  }

  addWorkspace(root: string): { workspace: WorkspaceInfo; existed: boolean } {
    const existing = [...this.places.values()].find(record => record.root === root);
    if (existing) return { workspace: workspaceInfo(existing), existed: true };
    const record = newPlace(
      { kind: 'workspace', key: `${WORKSPACE_PREFIX}${crypto.randomUUID()}` },
      basename(root),
      root,
    );
    this.places.set(record.key, record);
    this.markDirty();
    this.caps.logger.info(`登记工作区: ${record.name} (${record.key}) ${root}`);
    return { workspace: workspaceInfo(record), existed: false };
  }

  listWorkspaces(): WorkspaceInfo[] {
    return [...this.places.values()]
      .filter(record => record.kind === 'workspace')
      .sort((a, b) => defaultFirst(a.key, b.key) || a.createdAt - b.createdAt)
      .map(workspaceInfo);
  }

  async removeWorkspace(id: string): Promise<void> {
    if (id === DEFAULT_WORKSPACE) throw new Error('默认工作区不能取消登记');
    const key = `${WORKSPACE_PREFIX}${id}`;
    const record = this.places.get(key);
    if (!record) throw new Error(`工作区不存在：${id}`);
    // 先认出原属的会话树（按根会话记下的工作区），再一并清：根会话的所属工作区与绑定，整棵树的当前目录
    const affected = [...this.sessions.values()].filter(s => rootSessionOf(s, this.lookup)?.workspace === id);
    const changed = affected.filter(s => !s.parentId || s.currentDir !== undefined);
    for (const session of affected) {
      delete session.currentDir;
      if (!session.parentId) {
        delete session.workspace;
        delete session.work;
      }
    }
    this.places.delete(key);
    this.deleted[PLACES].set(key, Symbol(key));
    this.markDirty();
    this.caps.logger.info(`取消登记工作区: ${record.name} (${key})，${affected.length} 个会话归默认工作区`);
    for (const session of changed) await this.caps.events.emit('session:updated', session);
    await this.caps.events.emit('session:config:changed');
  }

  // ---- 生命周期 ----

  async completeSession(id: string, result?: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在: ${id}`);

    session.status = 'completed';
    session.result = result;
    session.updatedAt = Date.now();

    this.markDirty();

    // 发事件通知（wait_subtasks 通过事件驱动感知完成）
    await this.caps.events.emit('session:completed', session);

    this.caps.logger.info(`会话完成: ${session.name} (${id})${result ? ` - ${result.slice(0, 100)}` : ''}`);
  }

  // ---- 标题管理 ----

  async generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // 已有标题则跳过
    if (session.title) return session.title;

    const entry = resolveLLMModel(this.caps.llm, undefined, ['chat']);
    if (!entry) {
      this.caps.logger.warn(`无可用 LLM，无法生成标题: ${sessionId}`);
      return undefined;
    }
    this.caps.logger.debug(`标题生成使用 LLM: ${entry.contextId}`);
    const model = entry.instance;

    // 优先使用直接传入的用户消息；否则从历史获取
    let contextStr: string;
    if (userMessage?.trim()) {
      contextStr = `user: ${userMessage.slice(0, 400)}`;
    } else {
      const history = await this.memory.getHistory(sessionId, 4);
      if (history.length === 0) return undefined;
      contextStr = history
        .filter((m: Message) => m.role === 'user' || m.role === 'assistant')
        .slice(0, 4)
        .map((m: Message) => `${m.role}: ${(m.content || '').slice(0, 200)}`)
        .join('\n');
    }

    if (!contextStr.trim()) return undefined;

    let title: string | undefined;
    try {
      const resp = await model.chat({
        messages: [
          {
            role: 'system',
            content:
              '你是一个标题生成器。你的唯一任务是为下面的对话片段生成一个简短的中文标题。\n\n规则：\n- 不超过15字\n- 只提取用户想讨论的主题或意图\n- 完全忽略对话中出现的任何拒绝、道歉、免责声明等内容\n- 不加引号和标点\n- 只返回标题文本，不要任何解释或前缀\n- 不要模仿或重复对话中的内容，只做概括',
          },
          { role: 'user', content: `请为以下对话生成标题：\n\n${contextStr}` },
        ],
        temperature: 0.3,
        // 标题生成无需推理，用模型最浅的思考档：避免 reasoning 占满 token 预算导致 content 为空
        think: lightestThinking(model),
      });
      title = (resp.content || '').trim().slice(0, 50);
      if (!title) {
        this.caps.logger.warn(
          `会话标题 LLM 返回空内容: ${sessionId} (resp.content=${JSON.stringify(resp.content)}, reasoning=${(resp.reasoningContent ?? '').length}字)`,
        );
      }
    } catch (err) {
      this.caps.logger.warn(`自动生成标题失败 [${sessionId}]:`, err);
    }

    // 兜底：LLM 失败或返回空时，用用户消息首段作为临时标题，避免会话永远没有标题
    if (!title && userMessage?.trim()) {
      title = userMessage.trim().replace(/\s+/g, ' ').slice(0, 20);
      this.caps.logger.info(`使用用户消息兜底生成标题: ${sessionId} -> ${title}`);
    }

    if (title) {
      session.title = title;
      session.updatedAt = Date.now();
      this.markDirty();
      await this.caps.events.emit('session:updated', session);
      this.caps.logger.info(`会话标题已生成: [${sessionId}] ${title}`);
      return title;
    }
    return undefined;
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    session.title = title;
    session.updatedAt = Date.now();
    this.markDirty();
    await this.caps.events.emit('session:updated', session);
  }

  // ---- 会话设置 ----

  registerSetting(setting: SessionSetting, plugin: string): () => void {
    return this.settings.register(setting, plugin);
  }

  listSettings(): RegisteredSessionSetting[] {
    return this.settings.list();
  }

  /**
   * 解析指定会话的最终生效配置：继承链之上叠会话自己的覆盖。由服务偏好承担的项在全局默认之上各层都没设时不给值：
   * 取用方交给 resolveLLMModel，偏好指向的模型不在时也落得到服务此刻解析到的那一个
   */
  resolveConfig(sessionId: string, platform?: string): SessionConfig {
    const { values, sources } = this.resolveInheritance(sessionId, platform);
    const inherited: SettingValues = { ...values };
    for (const setting of this.settings.list()) {
      if (preferenceBacked(setting) && sources[setting.key] === 'defaults') delete inherited[setting.key];
    }
    return { ...inherited, ...this.getOwnConfig(sessionId) };
  }

  /**
   * 继承链解析：不含会话自身 config，按层表的先后叠加，另记下每个键来自哪一层。子会话按根会话取：有出生平台的会话不论从
   * 哪个入口驱动都按出生平台选平台档，按聊天窗口的类型名选平台类型档；传入的入口平台只对没有出生平台的会话起作用
   */
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance {
    const session = this.sessions.get(sessionId);
    const root = rootSessionOf(session, this.lookup);
    const ctx = {
      platform: root?.originPlatform ?? platform,
      type: root?.originPlatform === undefined ? undefined : root.originChat?.type,
      place: this.placeOf(sessionId),
      parent: session?.parentId ? this.sessions.get(session.parentId) : undefined,
    };
    return { platform: ctx.platform, type: ctx.type, ...this.stack(this.chain(ctx)) };
  }

  getOwnConfig(sessionId: string): SessionConfig {
    return this.valid(this.sessions.get(sessionId)?.config, `会话 ${sessionId}`, true);
  }

  childConfig(parentId: string, platform?: string): SessionConfig {
    const config = this.resolveConfig(parentId, platform) as SettingValues;
    for (const setting of this.settings.list()) {
      if (setting.liveOnly || setting.narrowest) delete config[setting.key];
    }
    return config;
  }

  resolvedDefaults(): SessionConfig {
    const entry = resolveLLMModel(this.caps.llm, undefined, ['chat']);
    if (!entry) return {};
    const model: ModelRef = { provider: entry.instance.providerId, model: entry.instance.id };
    return Object.fromEntries(this.settings.list().flatMap(s => (preferenceBacked(s) ? [[s.key, model]] : [])));
  }

  listLayers(): SessionConfigLayer[] {
    return SESSION_LAYERS.flatMap(({ name }): SessionConfigLayer[] =>
      Object.hasOwn(this.layerTable, name) ? this.layerTable[name as ConfigScope].list() : [],
    );
  }

  getLayer(layer: SessionConfigLayer): SessionConfig {
    const impl = this.implOf(layer);
    impl.assert(layer);
    return this.valid(impl.read(layer), impl.describe(layer));
  }

  resolveLayer(layer: SessionConfigLayer): Pick<SessionInheritance, 'values' | 'sources'> {
    const impl = this.implOf(layer);
    impl.assert(layer);
    return this.stack(this.chain(impl.context(layer), layer.scope));
  }

  async updateLayer(layer: SessionConfigLayer, patch: SessionConfigPatch): Promise<void> {
    const impl = this.implOf(layer);
    impl.assert(layer);
    const checked = checkPatch(this.settings, patch);
    await impl.write(layer, applyPatch(impl.read(layer), checked));
    this.caps.logger.info(`会话设置已改：${impl.describe(layer)}（${[...checked.keys()].join('、')}）`);
    void this.caps.events.emit('session:config:changed');
  }

  /** 这一层的实现；不认识的层抛 {@link SessionConfigError} */
  private implOf<L extends SessionConfigLayer>(layer: L): LayerImpl<L> {
    const scope: unknown = layer?.scope;
    if (typeof scope !== 'string' || !Object.hasOwn(this.layerTable, scope)) {
      throw new SessionConfigError(`会话设置的层不认识：${String(scope)}`);
    }
    return this.layerTable[scope as ConfigScope] as unknown as LayerImpl<L>;
  }

  /**
   * 按层表的先后取一个会话（或一层的视图）上各层的值，到 until 为止：会话之上的层各按自己的实现选那一份，父会话层是
   * 父会话的 sessionDefaults（旧数据）
   */
  private chain(ctx: LayerContext, until: InheritanceSource = 'parent'): Part[] {
    const parts: Part[] = [];
    for (const { name } of SESSION_LAYERS) {
      if (name === 'session') break;
      if (name === 'parent') {
        if (ctx.parent) parts.push([ctx.parent.config.sessionDefaults, name, `会话 ${ctx.parent.id} 给子会话的默认值`]);
      } else {
        const impl = this.layerTable[name] as LayerImpl<SessionConfigLayer>;
        const layer = impl.select(ctx);
        if (layer) parts.push([impl.read(layer), name, impl.describe(layer)]);
      }
      if (name === until) break;
    }
    return parts;
  }

  /** 按顺序叠加几处设置：后面的覆盖前面的，逐键记下来源 */
  private stack(parts: Part[]): Pick<SessionInheritance, 'values' | 'sources'> {
    const values: SettingValues = {};
    const sources: Record<string, InheritanceSource> = {};
    for (const [raw, source, where] of parts) {
      for (const [key, value] of Object.entries(this.valid(raw, where, source === 'parent'))) {
        values[key] = value;
        sources[key] = source;
      }
    }
    return { values, sources };
  }

  /** 宿主配置文档里的三层；没有文档时为空 */
  private docLayers(): DocLayers {
    return readLayers(this.caps.hostConfig.current?.get('sessionConfig'), message => this.warnOnce(message));
  }

  /** 改宿主配置文档并落盘：change 改文档并返回撤回它的函数。没有文档时抛错；落盘失败时撤回、以拒绝传出 */
  private async saveHost(change: (host: HostConfig) => () => void): Promise<void> {
    const host = this.caps.hostConfig.current;
    if (!host) throw new Error('宿主没有提供配置文档（host-config），会话设置的各层无处保存');
    const revert = change(host);
    try {
      await host.save();
    } catch (err) {
      // 拒写与写入失败都撤回：免得下一次任意保存把这次没存下的修改写进文件
      revert();
      throw err;
    }
  }

  /** 改文档里的三层：在现读的一份上改，整份写回 */
  private writeDoc(update: (layers: DocLayers) => void): Promise<void> {
    return this.saveHost(host => {
      const previous = host.get('sessionConfig');
      const layers = this.docLayers();
      update(layers);
      host.set('sessionConfig', writeLayers(layers));
      return () => host.set('sessionConfig', previous);
    });
  }

  /**
   * 全局默认层：文档里的 defaults，由服务偏好承担的项换成 llm 服务的偏好。文档里写了这些项的告警后忽略（按层写时不再写回）
   */
  private readDefaults(): SettingValues {
    const values: SettingValues = { ...this.docLayers().defaults };
    const preferred = this.preferredModel();
    for (const setting of this.settings.list()) {
      if (!preferenceBacked(setting)) continue;
      if (setting.key in values) {
        this.warnOnce(
          `宿主配置 sessionConfig.defaults.${setting.key} 不再生效，已忽略：默认模型只在 llm 服务的偏好里，` +
            '在「会话默认」的全局默认层改',
        );
      }
      delete values[setting.key];
      if (preferred) values[setting.key] = preferred;
    }
    return values;
  }

  /**
   * llm 服务的偏好写成模型引用：条目在时按它的提供者与模型 id；不在时按还装着的提供者拆（取能作为 `<提供者>/` 前缀的最长的
   * 一个，模型 id 里的斜杠留在模型里），提供者也不在时按最后一个斜杠拆。拆不出、或拆出的提供者只剩 npm scope（偏好只写了
   * 提供者，如 `@scope/llm-x`）的读不成模型引用，偏好没有生效由 doctor 报出
   */
  private preferredModel(): ModelRef | undefined {
    const contextId = this.caps.services.preferred(llm);
    if (contextId === undefined) return undefined;
    const entries = this.caps.llm.all();
    const entry = entries.find(e => e.contextId === contextId);
    if (entry) return { provider: entry.instance.providerId, model: entry.instance.id };
    const provider = entries
      .map(e => e.instance.providerId)
      .filter(id => contextId.startsWith(`${id}/`))
      .sort((a, b) => b.length - a.length)[0];
    const cut = provider === undefined ? contextId.lastIndexOf('/') : provider.length;
    const ref = { provider: contextId.slice(0, cut), model: contextId.slice(cut + 1) };
    return cut > 0 && !/^@[^/]*$/.test(ref.provider) ? ref : undefined;
  }

  /**
   * 写全局默认层：由服务偏好承担的项写 llm 服务的偏好（运行态与文档的 servicePreferences，没有值即取消偏好），其余写文档的
   * defaults。这一层读出的是偏好（{@link readDefaults}），按读出的值比：只有这一项改了才动偏好，几项都由偏好承担时取改了的
   * 那一项。读不成模型引用的偏好（手写的）读出来没有这一项，改别的项不碰它。落盘失败时偏好与文档一并撤回
   */
  private writeDefaults(values: SettingValues): Promise<void> {
    const backed = this.settings.list().filter(preferenceBacked);
    const preferred = this.preferredModel();
    const changed = backed.find(setting => !isDeepStrictEqual(values[setting.key], preferred));
    const ref = changed && (values[changed.key] as ModelRef | undefined);
    const rest = { ...values };
    for (const { key } of backed) delete rest[key];
    return this.saveHost(host => {
      const revertPreference = changed ? this.setPreference(host, ref && `${ref.provider}/${ref.model}`) : () => {};
      const previous = host.get('sessionConfig');
      host.set('sessionConfig', writeLayers({ ...this.docLayers(), defaults: rest }));
      return () => {
        host.set('sessionConfig', previous);
        revertPreference();
      };
    });
  }

  /** 改 llm 服务的偏好（运行态与文档），返回撤回它的函数。运行态拒绝（服务有独占的提供者）时抛错，什么都不改 */
  private setPreference(host: HostConfig, contextId: string | undefined): () => void {
    const runtime = this.caps.services.preferred(llm);
    const documented = host.getServicePreferences()[llm.name];
    const apply = (live: string | undefined, doc: string | undefined) => {
      if (live === undefined) this.caps.services.unprefer(llm);
      else if (!this.caps.services.prefer(llm, live)) throw new Error(`llm 服务不接受偏好 ${live}`);
      if (doc === undefined) host.removeServicePreference(llm.name);
      else host.setServicePreference(llm.name, doc);
    };
    apply(contextId, contextId);
    return () => apply(runtime, documented);
  }

  /**
   * 平台档可设的平台：已装适配器的平台加文档里写过的（两段里的都算），按名字排。名字不合层标识写法的不列（文档里的读时已滤掉）：
   * 列出的层都要能按层读写
   */
  private platformNames(): string[] {
    const doc = this.docLayers();
    const names = new Set([...doc.platforms.keys(), ...doc.types.keys()]);
    for (const adapter of getPlatformAdapters(this.caps.platform)) names.add(adapter.platform);
    return [...names].filter(isLayerName).sort();
  }

  /** 平台类型档可设的类型：适配器声明的类型加文档里写过的，按名字排；没声明类型的适配器不单列，名字不合写法的不列 */
  private typeNames(platform: string): string[] {
    const names = new Set(this.docLayers().types.get(platform)?.keys());
    for (const adapter of getPlatformAdapters(this.caps.platform)) {
      if (adapter.platform === platform) for (const type of adapter.sessionTypes ?? []) names.add(type.name);
    }
    return [...names].filter(isLayerName).sort();
  }

  /**
   * 一处设置里已登记的项：没登记的不参与解析；取值不合登记字段的当作没设置，字段标了 onInvalid: 'error' 的原样交出、
   * 由登记它的插件按拒绝处理。会话上的设置（会话自己的覆盖、父会话给子会话的默认值）里只能设到场所为止的项不参与解析：
   * 写入不收它，旧数据里留着的不能压过场所。这两种问题同一处同一项只告警一次
   */
  private valid(values: object | undefined, where: string, onSession = false): SettingValues {
    const out: SettingValues = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      // 清掉的覆盖经 BSON 落盘读回来是 null，与没有同义
      if (value === undefined || value === null) continue;
      const setting = this.settings.get(key);
      if (!setting) continue;
      if (onSession && setting.narrowest) {
        this.warnOnce(`设置项 ${key}（${where}）只能设到场所为止，会话上的值不生效：改到场所或以上的层，再清掉它`);
        continue;
      }
      const read = readSetting(setting, value);
      if (!('invalid' in read)) {
        if (read.value !== undefined) out[key] = read.value;
      } else if (setting.field.onInvalid === 'error') {
        this.warnOnce(`设置项 ${key}（${where}）取值无效（${read.invalid}），原样交给登记它的插件按拒绝处理`);
        out[key] = value;
      } else {
        this.warnOnce(`设置项 ${key}（${where}）取值无效（${read.invalid}），按没设置处理`);
      }
    }
    return out;
  }

  /** 写会话自己的覆盖：按登记的设置项校验，只能设到场所为止的项不收 */
  private checkedPatch(patch: SessionConfigPatch): Map<string, unknown> {
    const checked = checkPatch(this.settings, patch);
    assertSessionPatch(this.settings, checked);
    return checked;
  }

  /** 建会话时给的配置：校验后作为会话自己的覆盖 */
  private checkedConfig(config: SessionConfigPatch | undefined): SettingValues {
    return config ? applyPatch({}, this.checkedPatch(config)) : {};
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.caps.logger.warn(message);
  }

  private hasTurnInFlight(sessionId: string): boolean {
    for (const turn of this.turns.values()) if (turn.sessionId === sessionId) return true;
    return false;
  }

  /**
   * 回合开始：登记这一轮；已有记录且不是 active 的翻 active。归档的不翻：归档是 owner 不想在列表里看到它，
   * 她在那里跑一轮不该让它回到列表，只有手动恢复才回来
   */
  beginTurn(id: string, turnId: string): void {
    this.turns.set(turnId, { sessionId: id });
    const session = this.sessions.get(id);
    if (session && session.status !== 'active' && session.status !== 'archived') {
      this.updateSession(id, { status: 'active' }).catch(() => {});
    }
  }

  /** 记下这一轮的结局与出错原因（只有结局为 error 时留原因），回合结束时用 */
  recordOutcome(turnId: string, outcome: TurnOutcome, error: string | undefined): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.outcome = outcome;
    // 一句原因：agent 给的可能带上游的整段响应，会随会话落盘、进子任务提醒；空串当作没给
    turn.error = outcome === 'error' && error ? truncateChars(error, ERROR_MAX, '…') : undefined;
  }

  /**
   * 回合结束：注销这一轮，记下 lastTurn（被拦下、没有结局的一轮记为 silent），结局为 replied 的另记下她开口的时间。
   * 会话里的最后一轮结束时，仍为 active 的会话（根会话与子会话一样）按这一轮的结局收口：出错为 error，其余为 completed
   */
  endTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    const session = this.sessions.get(turn.sessionId);
    if (!session) return;
    const { outcome = 'silent', error } = turn;
    const endedAt = Date.now();
    session.lastTurn = error === undefined ? { outcome, endedAt } : { outcome, endedAt, error };
    if (outcome === 'replied') session.lastReplyAt = endedAt;
    const settle = session.status === 'active' && !this.hasTurnInFlight(session.id);
    const status = outcome === 'error' ? 'error' : 'completed';
    this.updateSession(session.id, settle ? { status } : {}).catch(() => {});
  }

  /** 按会话累加一次模型调用的 token：只记已有的会话，不改 updatedAt；记了就发 session:updated */
  recordUsage({ sessionId, inputTokens, outputTokens }: LLMUsageEvent): void {
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    if (!session) return;
    const { input, output } = session.tokens ?? { input: 0, output: 0 };
    session.tokens = { input: input + inputTokens, output: output + outputTokens };
    this.markDirty();
    void this.caps.events.emit('session:updated', session);
  }

  /**
   * 关停收尾：仍 `active` 的会话立即收口并落盘。
   *
   * 枚举没有 interrupted：回合结束（含用户停止 / abort）既有收口就是 `completed`，
   * 关停打断在飞回合与那条路径同义，沿用同一状态，不新造值。
   * waiting / completed / error / archived 不是在飞，原样保留。
   *
   * 第一方栈由 core 关停编排（optional 环成员先全部 drain）与回合结束时的收口（{@link endTurn}）处理；
   * 此处兜的是未装 agent 或钩子未挂上的路径。
   * persist 也在这里立刻刷，不走 1s debounce——onDispose 的 shutdown 仍会再刷一次。
   */
  async settleActiveOnDrain(): Promise<void> {
    let closed = 0;
    for (const session of this.sessions.values()) {
      if (session.status !== 'active') continue;
      session.status = 'completed';
      session.updatedAt = Date.now();
      closed++;
    }
    if (closed > 0) this.dirty = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  /** 强制持久化并清理定时器 */
  async shutdown(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = true;
    await this.persist();
  }
}

// ===== 工具函数 =====

/**
 * 会话的种类，只由父会话与出生平台推出。新建、建档、补记与加载入表时覆盖写入，调用方传的值与存储里的旧值都不采信
 */
function describeSession(session: Pick<SessionInfo, 'parentId' | 'originPlatform'>): Pick<SessionInfo, 'kind'> {
  return { kind: sessionKind(session) };
}

/** 新建的场所记录：设置为空 */
function newPlace(place: SessionPlace, name: string, root?: string): PlaceRecord {
  const now = Date.now();
  return { ...place, name, ...(root === undefined ? {} : { root }), config: {}, createdAt: now, updatedAt: now };
}

function placeInfo({ kind, key, name }: PlaceRecord): PlaceInfo {
  return { kind, key, name };
}

function workspaceInfo({ key, name, root }: PlaceRecord): WorkspaceInfo {
  return { id: key.slice(WORKSPACE_PREFIX.length), name, ...(root === undefined ? {} : { root }) };
}

/** 排序时默认工作区在前，其余不动 */
function defaultFirst(a: string, b: string): number {
  return Number(b === DEFAULT_PLACE.key) - Number(a === DEFAULT_PLACE.key);
}

const SESSION_STATUSES: ReadonlySet<unknown> = new Set<SessionInfo['status']>([
  'active',
  'waiting',
  'completed',
  'error',
  'archived',
]);
const TURN_OUTCOMES: ReadonlySet<unknown> = new Set<NonNullable<SessionInfo['lastTurn']>['outcome']>([
  'replied',
  'silent',
  'aborted',
  'error',
]);

const isText = (value: unknown) => typeof value === 'string';
const isTextList = (value: unknown) => Array.isArray(value) && value.every(isText);
const isTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 会话记录里会进会话列表与协议、类型不对会让读者出错的可选字段，各自的类型。种类载入时重算，不在这里
 */
const OPTIONAL_FIELDS: Record<string, (value: unknown) => boolean> = {
  title: isText,
  parentId: isText,
  createdFrom: isText,
  originPlatform: isText,
  originChat: value =>
    isRecord(value) &&
    isText(value.type) &&
    typeof value.multiParty === 'boolean' &&
    isText(value.targetId) &&
    (value.selfId === undefined || isText(value.selfId)),
  workspace: isText,
  work: value => isRecord(value) && isText(value.root) && isTextList(value.extraRoots) && isTextList(value.worktrees),
  currentDir: isText,
  originInstance: isText,
  lastReplyAt: isTime,
  lastTurn: value =>
    isRecord(value) &&
    TURN_OUTCOMES.has(value.outcome) &&
    isTime(value.endedAt) &&
    (value.error === undefined || isText(value.error)),
  tokens: value => isRecord(value) && isTime(value.input) && isTime(value.output),
};

/**
 * 读回的会话记录：存储把没有的可选字段存成 null 的（MongoDB 就是这样）去掉这个键。字段不对的（旧数据、手改或别的插件写坏的）：
 * 可选字段去掉，记在 dropped 里；必填字段不对时回这个字段名，整条不载入
 */
function storedSession(
  key: string,
  data: Record<string, unknown>,
): { record: SessionInfo; dropped: string[] } | { wrong: string } {
  const record = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
  const required: Record<string, boolean> = {
    id: record.id === key,
    name: isText(record.name),
    children: isTextList(record.children),
    status: SESSION_STATUSES.has(record.status),
    config: isRecord(record.config),
    createdAt: isTime(record.createdAt),
    updatedAt: isTime(record.updatedAt),
  };
  const wrong = Object.keys(required).find(field => !required[field]);
  if (wrong) return { wrong };
  const dropped = Object.entries(OPTIONAL_FIELDS)
    .filter(([field, valid]) => record[field] !== undefined && !valid(record[field]))
    .map(([field]) => field);
  for (const field of dropped) delete record[field];
  return { record: record as unknown as SessionInfo, dropped };
}

/**
 * 读回的场所记录：必填字段不对（含类别与键对不上：工作区的键以 `workspace:` 开头，窗口的不是）时回这个字段名，整条不载入；
 * 目录的类型不对时去掉它
 */
function storedPlace(
  key: string,
  data: Record<string, unknown>,
): { record: PlaceRecord; dropped: string[] } | { wrong: string } {
  const record = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
  const required: Record<string, boolean> = {
    key: record.key === key,
    kind:
      (record.kind === 'workspace' || record.kind === 'window') &&
      (record.kind === 'workspace') === key.startsWith(WORKSPACE_PREFIX),
    name: isText(record.name),
    config: isRecord(record.config),
    createdAt: isTime(record.createdAt),
    updatedAt: isTime(record.updatedAt),
  };
  const wrong = Object.keys(required).find(field => !required[field]);
  if (wrong) return { wrong };
  const dropped = record.root !== undefined && !isText(record.root) ? ['root'] : [];
  if (dropped.length > 0) delete record.root;
  return { record: record as unknown as PlaceRecord, dropped };
}

// ===== 插件入口 =====

const uses = {
  /** 会话档案与消息历史的唯一落点：没有 memory 就没有会话管理 */
  memory,
  /**
   * 本插件不调用 agent 的方法；声明它是为了 agent:* 钩子的键类型。
   * 第一方栈由 core 关停编排（optional 环成员先全部 drain）与回合结束时的收口处理；
   * 此处 onDrain 兜的是未装 agent 或钩子未挂上的路径。
   */
  agent: optional(agent),
  /** 自动标题的模型来源（没有 LLM 时退回用户消息首段）；全局默认层的「模型」按偏好指向的条目写出提供者与模型 */
  llm: optional(llm),
  /** 房间建档时取平台的类型声明记下聊天窗口；解析接管房间的适配器实例（originInstance）；可设的平台与类型 */
  platform: optional(platform),
  /**
   * 会话设置的全局默认、平台档与平台类型档存放在宿主配置文档的 sessionConfig 字段里。由宿主在根上提供、没有插件
   * provide 它，写进激活闸只会挂一条解析不到提供者的告警；缺席时这三层为空、按层写被拒
   */
  hostConfig: optional(hostConfig),
  /**
   * owner 的 IM 私聊在默认工作区：placeOf 按它认对端是不是 owner，与房间类别同一判据。plugin-authority 也以 optional
   * 用会话管理，两边成可选环；缺席时认不出 owner，一对一窗口按窗口算
   */
  authority: optional(authority),
  /** 全局默认层的「模型」读写 llm 服务的偏好 */
  services,
  events,
  hooks,
  lifecycle,
  logger,
  provide,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-session-manager',
  displayName: '会话管理',
  subsystem: 'session',
  provides: [sessionManager],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { memory, events, hooks, lifecycle, logger, provide } = caps;

  const manager = new SessionManager(caps);

  // 会话表跟随 memory 胜者：首次挂接即加载；运行中胜者换人时先写回旧后端再读新后端
  memory.follow(instance => manager.attach(instance));
  await manager.loading;
  // 读表（含重试等待）期间停用或停机的，不再发布服务与登记
  lifecycle.signal.throwIfAborted();

  // 注册服务
  provide(sessionManager, manager, { label: '会话管理' });

  // ===== IM 房间收录 =====
  // 会话表里还没有记录的真人入站（不带 source、不是子任务）按这条消息建档：出生平台取消息的平台，聊天窗口按这个平台的
  // 类型声明经 chatScopeOf 记下，之后不变。WebUI 与终端的会话在入站之前已建档、带创建来源，不经这里。带 source 的是
  // 内部注入（工作流、定时任务、空闲开话题、宿主通知、好友申请与入群邀请的合成通知），不登记。消息带的类型名不在平台的
  // 声明里时按多方记下，每个平台与类型名告警一次；消息没带类型名、按平台声明的第一个多方类型记下时，每个平台告警一次。
  // 按 id 兜底建档的根会话（注入回合在未登记的房间开子任务）没有来源字段，升级前的记录只记了出生平台、没有聊天窗口，
  // 两者都由第一条归它的适配器管的原生入站补记（backfillRoom；后者只认出生平台的入站）。
  // 收录与补记之前问遍认领这个 id 的适配器（claimantsOf），第一个认领者随来源字段记作所属实例。认领它的平台不止一个
  // （如终端配置的会话 id 配成了群的 id）时判不出它是谁的窗口，不收录、不补记，每个 id 告警一次：结果不能取决于
  // 适配器的登记先后。问的期间别的入站可能已收录，问完按会话表此刻的记录判，再同步建档或补记。
  // 名字只采信出生平台自己的入站：多方取群名、一对一取对方昵称，缺省用 id（群的首条入站可能是不带群名的戳一戳，
  // 不回退到昵称）。现名还是 id 时由后到的原生入站补上，起过的名字不动；补记不成、仍没有聊天窗口的记录判不出该取哪个，
  // 不补。
  // 场所是窗口的同时建窗口的场所记录，它的显示名随出生平台的入站更新（owner 的 IM 私聊在默认工作区，不建）。
  // 已登记、还没记下所属实例的房间，每条真人入站都再解析一次，认领到就补记。
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message);
  };
  /** 不经这条入站收录或补记的会话：有聊天窗口、创建来源或绑定的，与出生平台不是消息平台的 */
  const recorded = (session: SessionInfo | undefined, msg: IncomingMessage): session is SessionInfo =>
    session !== undefined &&
    (Boolean(session.originChat || session.createdFrom || session.work) ||
      (session.originPlatform ?? msg.platform) !== msg.platform);
  /** 已收录的会话：出生平台的入站补名、更新窗口的显示名，还没记下所属实例的再解析一次 */
  const noteRecorded = (session: SessionInfo, msg: IncomingMessage) => {
    const chat = session.originChat;
    if (chat && session.originPlatform === msg.platform) {
      const nativeName = chat.multiParty ? msg.groupName : msg.nickname;
      if (nativeName && session.name === session.id)
        manager.updateSession(session.id, { name: nativeName }).catch(() => {});
      void manager.noteWindow(session.id, nativeName);
    }
    void manager.recordOriginInstance(session);
  };
  events.on('inbound:message', async (msg: IncomingMessage) => {
    const { sessionId } = msg;
    if (!sessionId || msg.source || sessionId.includes('::')) return;
    const known = manager.getSession(sessionId);
    if (recorded(known, msg)) {
      noteRecorded(known, msg);
      return;
    }
    const claimants = await claimantsOf(caps.platform, sessionId, logger);
    const session = manager.getSession(sessionId);
    if (recorded(session, msg)) {
      noteRecorded(session, msg);
      return;
    }
    const platforms = [...new Set(claimants.map(({ instance }) => instance.platform))];
    if (platforms.length > 1) {
      warnOnce(
        `claim:${sessionId}`,
        `会话 ${sessionId} 同时由平台「${platforms.join('」「')}」认领：判不出它是哪个平台的聊天窗口，不收录。` +
          '改配置，一个会话 id 只归一个平台',
      );
      return;
    }
    // 补记只认这个 id 归消息平台的适配器管的入站：WebUI 与终端往房间插话不算
    if (session && platforms[0] !== msg.platform) return;
    const adapter = getPlatformAdapters(caps.platform).find(a => a.platform === msg.platform);
    const scope = chatScopeOf(msg, sessionTypesOf(adapter));
    if (scope.undeclared) {
      warnOnce(
        `type:${scope.platform}:${scope.type}`,
        `平台「${scope.platform}」没有声明类型「${scope.type}」（${sessionId}）：这个聊天窗口按多方记下。` +
          '适配器要在 sessionTypes 里声明它发出的类型名',
      );
    } else if (msg.sessionType === undefined && scope.multiParty) {
      warnOnce(
        `untyped:${scope.platform}`,
        `平台「${scope.platform}」的消息没带类型名（${sessionId}）：这个聊天窗口按类型「${scope.type}」、多方记下。` +
          '适配器要在消息上带类型名',
      );
    }
    const originChat: OriginChat = {
      type: scope.type,
      multiParty: scope.multiParty,
      ...(msg.selfId === undefined ? {} : { selfId: msg.selfId }),
      targetId: scope.targetId,
    };
    const nativeName = scope.multiParty ? msg.groupName : msg.nickname;
    const origin: RoomOrigin = {
      originPlatform: msg.platform,
      originChat,
      ...(claimants[0] ? { originInstance: claimants[0].contextId } : {}),
    };
    (session
      ? manager.backfillRoom(session, nativeName, origin)
      : manager.recordRoom(sessionId, nativeName, origin)
    ).catch(err => logger.warn(`IM 房间登记失败 (${sessionId}):`, err));
  });

  // 全局默认层的「模型」就是 llm 服务的偏好：偏好从别处改了（宿主启动时应用）、llm 的提供者上下线（偏好指向的模型在不在、
  // 服务实际用的那一个随之变）同样算会话设置变了
  events.on('service:changed', name => {
    if (name === llm.name) void events.emit('session:config:changed');
  });

  // ===== 会话状态 =====
  // 回合真正开始时（agent:input:before）才翻 active，归档的不翻：群里只有消息、她没开口的房间不显示「进行中」
  //（触发判定在入站相位，挡下的消息到不了这里）。同一个中间件在 finally 里记下这一轮并收口，根会话与子会话一样，这是
  // 唯一的收口：next() 返回时整轮已跑完、agent:turn:after 也已执行（agent 只在这个钩子的默认动作里发它），结局已经记下；
  // 后面的中间件不调 next() 或抛错时 agent 不发回合收尾，同样由这里兜住。按回合 id 登记在飞的回合，会话里最后一轮结束
  // 才收口，别的 lane 还在跑时不显示已完成；回合中途的出站（send_attachment、paper_send 在工具执行中直接发）不收口。
  hooks.middleware('agent:input:before', async (data, next) => {
    manager.beginTurn(data.message.sessionId, data.turnId);
    try {
      await next();
    } finally {
      manager.endTurn(data.turnId);
    }
  });
  hooks.middleware('agent:turn:after', async (data, next) => {
    manager.recordOutcome(data.turnId, data.outcome, data.error);
    await next();
  });
  // 模型调用的 token 按会话累加：对话、摘要、识图、转写的调用都带会话 id
  events.on('llm:usage', usage => manager.recordUsage(usage));

  // 自动标题：只给带创建来源的根会话（WebUI 新建的、终端建的）生成，在首条消息时生成、不等回复；IM 房间不生成，
  // owner 从 WebUI 往房间插话也不拿来给房间起名。异步生成，不阻塞消息处理；直接传入这条消息，不依赖历史
  const titleGenerating = new Set<string>();
  events.on('inbound:message', (msg: IncomingMessage) => {
    const { sessionId } = msg;
    const session = manager.getSession(sessionId);
    if (!session?.createdFrom || session.title || titleGenerating.has(sessionId)) return;
    titleGenerating.add(sessionId);
    logger.info(`开始生成会话标题: ${sessionId}`);
    manager
      .generateTitle(sessionId, msg.content)
      .catch(err => logger.warn('标题生成失败:', err))
      .finally(() => titleGenerating.delete(sessionId));
  });

  // 关停收尾：仍 active 的会话在 onDrain 收口并落盘。
  // 第一方栈由 core 关停编排（optional 环成员先全部 drain）与回合结束时的收口处理；
  // 此处兜的是未装 agent 或钩子未挂上的路径。
  // 持久化仍走 onDispose：覆盖 bounce / unload / updateConfig 等全部拆卸路径
  // （只在全局停机触发的话，热重载即丢会话元数据）。
  // 异步收尾由编排层的 disposeAsync 等待完成；app.stop() 的拓扑逆序保证此时 memory 提供者
  // 尚未关闭，单独热重载/禁用 memory 提供者时无此保证。shutdown() 幂等：清 timer + 置 dirty + 落盘。
  lifecycle.onDrain(() => manager.settleActiveOnDrain(), '收口在飞会话');
  lifecycle.onDispose(() => manager.shutdown());

  logger.info('会话管理服务已启用');
}

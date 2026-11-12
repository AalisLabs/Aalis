import { basename } from 'node:path';
import { agent } from '@aalis/api-agent';
import { authority } from '@aalis/api-authority';
import { events } from '@aalis/api-events';
import { chatScopeOf, windowKey } from '@aalis/api-gateway';
import { type HookContextMap, hooks } from '@aalis/api-hooks';
import { ownHostConfig } from '@aalis/api-host-config';
import { i18n, outputLanguageFor } from '@aalis/api-i18n';
import { type LLMUsageEvent, lightestThinking, llm, resolveLLMModel } from '@aalis/api-llm';
import { historyCleared, type MemoryService, type MetadataOp, memory } from '@aalis/api-memory';
import {
  claimantsOf,
  getPlatformAdapters,
  platform,
  resolvePlatformBySession,
  sessionTypesOf,
} from '@aalis/api-platform';
import {
  isUnfiled,
  type NewSessionFields,
  type OriginChat,
  oneToOneWith,
  type PlaceInfo,
  rootSessionOf,
  type SessionCreation,
  type SessionInfo,
  type SessionManagerService,
  type SessionPlace,
  type SessionUpdates,
  sessionKind,
  sessionLabel,
  sessionManager,
  TAKE_UNKNOWN,
  type TakeVerdict,
  type WorkBinding,
  type WorkspaceInfo,
} from '@aalis/api-session-manager';
import { type SessionFieldReader, sessionFields } from '@aalis/api-session-settings';
import { type BoundOf, config, definePlugin, lifecycle, logger, optional, provide } from '@aalis/core';
import { defineConfig } from '@aalis/schema-config';
import { asText, type TextRef, toSource, truncateParams, withText } from '@aalis/schema-i18n';
import type { IncomingMessage, Message } from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';
import { t } from './texts.js';

// ===== 配置 =====

// 取别的会话的东西（canTake）的范围与三个开关：都是按会话字段，按取的一方所在的会话生效。坏值原样交来，范围按本会话、开关按否
const configSchema = defineConfig({
  takeScope: {
    type: 'select',
    label: t('takeScopeLabel'),
    description: t('takeScopeDescription'),
    default: 'platform',
    onInvalid: 'error',
    options: [
      { label: t('takeScopeSession'), value: 'session' },
      { label: t('takeScopePlatform'), value: 'platform' },
      { label: t('takeScopeAll'), value: 'all' },
    ],
    session: { prominence: 'advanced' },
  },
  takeOtherGroups: {
    type: 'boolean',
    label: t('takeOtherGroupsLabel'),
    description: t('takeOtherGroupsDescription'),
    default: true,
    onInvalid: 'error',
    session: { prominence: 'advanced' },
  },
  takeOthersPrivate: {
    type: 'boolean',
    label: t('takeOthersPrivateLabel'),
    description: t('takeOthersPrivateDescription'),
    default: false,
    onInvalid: 'error',
    session: { prominence: 'advanced' },
  },
  takeCrossBot: {
    type: 'boolean',
    label: t('takeCrossBotLabel'),
    description: t('takeCrossBotDescription'),
    default: false,
    onInvalid: 'error',
    session: { prominence: 'advanced' },
  },
});

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
 * SessionManager 用到的能力：落盘的 memory、会话事件、memory:clear 钩子、标题生成的 LLM 与输出语言、中止读表重试的 lifecycle，
 * 收录房间时问认领者、取类型声明、解析接管房间的适配器实例的 platform，与判 owner 的 IM 私聊的 authority
 */
type ManagerCaps = Pick<
  Caps,
  'memory' | 'events' | 'hooks' | 'logger' | 'llm' | 'i18n' | 'agent' | 'lifecycle' | 'platform' | 'authority'
>;

/** 回合的结局（api-agent 的 agent:turn:after） */
type TurnOutcome = HookContextMap['agent:turn:after']['outcome'];

/** IM 房间收录按原生入站记下的来源字段，与收录之前解析到的接管它的适配器实例（没有适配器认领时不带） */
type RoomOrigin = Required<Pick<SessionInfo, 'originPlatform' | 'originChat'>> & Pick<SessionInfo, 'originInstance'>;

/** 场所记录：显示名、插件的扩展元数据与项目工作区的目录 */
interface PlaceRecord extends PlaceInfo {
  /** 目录的真实路径：只有项目工作区带 */
  root?: string;
  createdAt: number;
  updatedAt: number;
}

/** 存在记忆后端元数据里的两张表 */
type Table = typeof SESSIONS | typeof PLACES;

class SessionManager implements SessionManagerService {
  private sessions = new Map<string, SessionInfo>();
  /** 场所记录：键 → 记录。与会话表一同加载与落盘 */
  private places = new Map<string, PlaceRecord>();
  private caps: ManagerCaps;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** shutdown 刷过盘之后为真：之后的改动不再排落盘定时器（本激活已关掉，不在关掉之后写） */
  private closed = false;
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
  /** 已告警过的问题（坏数据、收录判不出的认领）：同一处只告警一次 */
  private readonly warned = new Set<string>();
  /** 正在收录或补记的会话：同一会话并发的原生入站共用这一次 */
  private readonly recording = new Map<string, Promise<void>>();
  /** 正在删除的会话（从摘掉、删子会话之前起，到清完数据），删除做完时兑现：这期间到的同一会话的入站等它（见 recordInbound） */
  private readonly removing = new Map<string, Promise<void>>();
  /**
   * 各会话的代号（generationOf）：开始删除的次数，在 remove 里加一，没删过的为 0。只记删过的 id，一直留着（之后同一 id 再建档
   * 也不换回去，半路上删除之前的一代才认得出来），每个删过的 id 占一项；随这次激活，会话管理重新激活时清空
   */
  private readonly generations = new Map<string, number>();
  /**
   * 在飞的回合：turnId → 所在会话与这一轮的结局（出错时带原因）。agent:turn:before 进出登记与注销，结局由
   * agent:turn:after 记下（被拦下的一轮不发它，没有结局）。第一方 agent 同一会话一轮接一轮，契约不限别的实现在同一会话并行几轮，
   * 所以按回合 id 记、会话在最后一轮结束时才收口；回合之外建档的会话按这里有没有回合定初始状态（见 ensureSession）
   */
  private turns = new Map<string, { sessionId: string; outcome?: TurnOutcome; error?: string | TextRef }>();
  /** 正在解析所属实例的会话记录：同一条记录不并发解析，后到的调用不等它、直接返回 */
  private resolving = new WeakSet<SessionInfo>();
  private readonly lookup = (id: string) => this.sessions.get(id);

  /** take 读取的一方所在会话此刻的取别的会话的范围与三个开关（生效值，坏值原样） */
  constructor(
    caps: ManagerCaps,
    private readonly take: SessionFieldReader<typeof configSchema>,
  ) {
    this.caps = caps;
  }

  /**
   * 消息历史类操作（清空、读历史）用当前胜者：新消息写在当前胜者里。每次惰性查询，provider 切换后自然跟随。
   * 会话表另经 {@link store} 跟随，见 {@link attach}。
   */
  private get memory(): MemoryService {
    if (!this.caps.memory.present) throw new Error('session-manager 需要 memory 服务');
    return this.caps.memory.use;
  }

  /**
   * memory 胜者的 follow 挂接：从这个实例读会话表与场所记录，整体替换内存里的这份。
   * 返回的清理在换人或关闭时执行：中止读表重试的等待，等本次加载落定，再把未落盘的变更写回这个实例。
   */
  attach(instance: MemoryService): () => Promise<void> {
    const detached = new AbortController();
    // 挂上的句柄只活到这次挂载的清理落定；之后的落盘（换人后的加载窗口、停机时的收尾）按条目 id 打到这一家
    const id = this.caps.memory.list().find(p => p.selected)?.id;
    const target = id === undefined ? instance : this.caps.memory.of(id);
    this.loading = this.load(instance, target, AbortSignal.any([detached.signal, this.caps.lifecycle.use.signal]));
    return async () => {
      detached.abort();
      await this.loading;
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      // 这一家可能已经撤回：清理期间经挂上的句柄落盘
      await this.persist(instance).catch(err => this.caps.logger.use.warn('换后端前落盘会话失败:', err));
    };
  }

  /**
   * 从 memory 元数据加载会话表与场所记录，加载完成后以它们为准、以这个实例为落盘目标。读表失败按 {@link LOAD_RETRY_DELAYS}
   * 有限重试，其间仍用原来的表与落盘目标；用尽或被中止（换人、停机）时两张表为空且不落盘。默认工作区的记录不在时补上
   * （随下一次落盘写进后端）。
   */
  private async load(instance: MemoryService, target: MemoryService, signal: AbortSignal): Promise<void> {
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
          this.caps.logger.use.warn(`加载会话数据失败，${delay}ms 后重试:`, err);
          await wait(delay, signal);
          if (!signal.aborted) continue;
        }
        if (signal.aborted) this.caps.logger.use.info('已中止加载会话数据（停用、停机或换后端）');
        else this.caps.logger.use.error('加载会话数据失败，在这个后端上的会话改动不落盘（以免覆盖原有记录）:', err);
        break;
      }
    }
    // 加载窗口里旧表的改动：落盘目标此前仍是旧的那一家，换表前取快照，换表后写回
    const previous = this.store;
    const pending = previous && this.dirty ? this.snapshot().ops : undefined;
    this.sessions = loaded?.sessions ?? new Map();
    this.places = loaded?.places ?? new Map();
    if (!this.places.has(DEFAULT_PLACE.key)) this.places.set(DEFAULT_PLACE.key, newPlace(DEFAULT_PLACE));
    this.deleted = { [SESSIONS]: new Map(), [PLACES]: new Map() };
    this.dirty = false;
    this.store = loaded ? target : undefined;
    if (loaded) this.caps.logger.use.info(`已加载 ${loaded.sessions.size} 个会话、${loaded.places.size} 个场所`);
    if (previous && pending) {
      try {
        await previous.commitMetadata(pending);
      } catch (err) {
        this.caps.logger.use.warn('换后端时写回旧后端失败:', err);
      }
    }
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
      this.caps.logger.use.warn(
        `${label}的必填字段不对，没有载入，原记录已移到 metadata 命名空间 ${aside}：` +
          rejected.map(({ key, field }) => `${key}（${field}）`).join('、'),
      );
    }
    if (dropped.length > 0)
      this.caps.logger.use.warn(`${label}有字段类型不对，去掉这些字段后照常载入：${dropped.join('、')}`);
    return rows;
  }

  /** 标记需要持久化并延迟刷盘 */
  private markDirty(): void {
    this.dirty = true;
    if (!this.persistTimer && !this.closed) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.persist().catch(err => this.caps.logger.use.warn('持久化会话失败:', err));
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
  async persist(target = this.store): Promise<void> {
    if (!this.dirty || !this.store || !target) return;
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
   * 按精确 id 幂等 upsert：命中走 updateSession（emit `session:updated`），未命中以传入 id 建档。
   * 创建来源在建档时写；命中按 id 兜底建档留下的空记录（{@link isUnfiled}）时补写，随这次更新落盘。
   * 终端配置的会话 id、在收录不了的会话上写设置时用
   */
  async ensureSession(
    id: string,
    patch: SessionUpdates = {},
    creation?: Pick<SessionCreation, 'createdFrom'>,
  ): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (!session) return this.insert(id, patch, creation ? { createdFrom: creation.createdFrom } : {});
    if (creation && isUnfiled(session)) session.createdFrom = creation.createdFrom;
    return this.updateSession(id, patch);
  }

  /**
   * IM 房间收录：按原生入站记下的出生平台与聊天窗口建档，名字取出生平台给的群名或昵称（没有时不取名）。只给会话表里
   * 还没有的 id 同步调用。场所是窗口的同时确保窗口的场所记录：insert 在第一次等待之前已同步占住 id、记下来源字段
   */
  async recordRoom(id: string, nativeName: string | undefined, origin: RoomOrigin): Promise<SessionInfo> {
    const [created] = await Promise.all([
      this.insert(id, { name: nativeName, status: 'waiting' }, origin),
      this.noteWindow(id, nativeName),
    ]);
    return created;
  }

  /**
   * IM 房间收录的补记：按 id 兜底建档的根会话（没有来源字段、创建来源与绑定）与升级前只记了出生平台的记录（没有聊天窗口，
   * 出生平台与消息平台相同）收到原生入站时，记下与按这条消息建档时一样的来源字段，还没有名字的一并补上，场所是窗口的
   * 确保窗口的场所记录。只给表里这条记录同步调用，由收录监听判定这个 id 归消息平台的适配器管
   */
  async backfillRoom(session: SessionInfo, nativeName: string | undefined, origin: RoomOrigin): Promise<void> {
    Object.assign(session, origin, session.name === undefined && nativeName ? { name: nativeName } : {});
    Object.assign(session, describeSession(session));
    await this.noteWindow(session.id, nativeName);
    this.markDirty();
    await this.caps.events.use.emit('session:updated', session);
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
        await this.caps.events.use.emit('session:updated', session);
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
    const now = Date.now();
    const session: SessionInfo = {
      id,
      name: patch.name || undefined,
      parentId: undefined,
      children: [],
      status: patch.status || (this.hasTurnInFlight(id) ? 'active' : 'waiting'),
      createdAt: now,
      updatedAt: now,
      metadata: patch.metadata,
      ...fields,
      ...describeSession(fields),
    };
    this.sessions.set(id, session);
    this.markDirty();
    await this.caps.events.use.emit('session:created', session);
    this.caps.logger.use.info(`会话建档(ensure): ${toSource(sessionLabel(session))} (${id})`);
    return session;
  }

  /**
   * 原生入站的收录与补记。会话表里还没有记录的真人入站（不带 source）按这条消息建档：出生平台取消息的平台，聊天窗口按这个
   * 平台的类型声明经 chatScopeOf 记下，之后不变。WebUI 与终端的会话在入站之前已建档、带创建来源，走快路径。带 source 的是
   * 内部注入（工作流、定时任务、空闲开话题、宿主通知、好友申请与入群邀请的合成通知），不登记；子会话按 parentId 不登记（recorded）。
   * 消息带的类型名不在平台的声明里时按多方记下，每个平台与类型名告警一次；消息没带类型名、按平台声明的第一个多方类型记下时，
   * 每个平台告警一次。按 id 兜底建档的根会话（注入回合在未登记的房间开子任务）没有来源字段，升级前的记录只记了出生平台、没有
   * 聊天窗口，两者都由第一条归它的适配器管的原生入站补记（backfillRoom；后者只认出生平台的入站）。
   * 收录与补记之前问遍认领这个 id 的适配器（claimantsOf），第一个认领者随来源字段记作所属实例。认领它的平台不止一个
   * （如终端配置的会话 id 配成了群的 id）时判不出它是谁的窗口，不收录、不补记，每个 id 告警一次：结果不能取决于
   * 适配器的登记先后。问的期间别的入站可能已收录，问完按会话表此刻的记录判，再建档或补记。同一会话并发的调用共用这一次。
   * 名字只采信出生平台自己的入站：多方取群名、一对一取对方昵称，缺省不取名（群的首条入站可能是不带群名的戳一戳，
   * 不回退到昵称）。没有名字时由后到的原生入站补上，起过的名字不动；补记不成、仍没有聊天窗口的记录判不出该取哪个，不补。
   * 场所是窗口的同时建窗口的场所记录，它的显示名随出生平台的入站更新（owner 的 IM 私聊在默认工作区，不建）。
   * 已登记、还没记下所属实例的房间，每条真人入站都再解析一次，认领到就补记。不会拒绝：收录失败只告警。
   * 这个会话正在删除时（带 source 的也一样）先等删除做完，问认领者的期间开始删除的同样等删完再从头问：删除期间到的是新的
   * 一代，不被这次删除停下、清掉
   */
  recordInbound(msg: IncomingMessage): Promise<void> {
    const { sessionId } = msg;
    const removing = this.removing.get(sessionId);
    if (removing) return removing.then(() => this.recordInbound(msg));
    if (!sessionId || msg.source) return Promise.resolve();
    const known = this.sessions.get(sessionId);
    if (this.recorded(known, msg)) {
      this.noteRecorded(known, msg);
      return Promise.resolve();
    }
    const pending = this.recording.get(sessionId);
    if (pending) return pending;
    const recording = this.record(msg)
      .catch(err => this.caps.logger.use.warn(`IM 房间登记失败 (${sessionId}):`, err))
      .finally(() => this.recording.delete(sessionId));
    this.recording.set(sessionId, recording);
    return recording;
  }

  generationOf(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  /** 不经这条入站收录或补记的会话：子会话（没有窗口），有聊天窗口、创建来源或绑定的，与出生平台不是消息平台的 */
  private recorded(session: SessionInfo | undefined, msg: IncomingMessage): session is SessionInfo {
    return (
      session !== undefined &&
      (Boolean(session.parentId || session.originChat || session.createdFrom || session.work) ||
        (session.originPlatform ?? msg.platform) !== msg.platform)
    );
  }

  /** 已收录的会话：出生平台的入站补名、更新窗口的显示名，还没记下所属实例的再解析一次（都不等） */
  private noteRecorded(session: SessionInfo, msg: IncomingMessage): void {
    const chat = session.originChat;
    if (chat && session.originPlatform === msg.platform) {
      const nativeName = chat.multiParty ? msg.groupName : msg.nickname;
      if (nativeName && session.name === undefined)
        this.updateSession(session.id, { name: nativeName }).catch(() => {});
      void this.noteWindow(session.id, nativeName);
    }
    void this.recordOriginInstance(session);
  }

  /** 问完认领者再收录或补记，见 {@link recordInbound} */
  private async record(msg: IncomingMessage): Promise<void> {
    const { sessionId } = msg;
    const claimants = await claimantsOf(this.caps.platform, sessionId, this.caps.logger.use);
    // 问的期间开始删除这个会话的，与入口同一条规则：等删除做完再从头问
    const removing = this.removing.get(sessionId);
    if (removing) return removing.then(() => this.record(msg));
    const session = this.sessions.get(sessionId);
    if (this.recorded(session, msg)) {
      this.noteRecorded(session, msg);
      return;
    }
    const platforms = [...new Set(claimants.map(({ use: instance }) => instance.platform))];
    if (platforms.length > 1) {
      this.warnOnce(
        `会话 ${sessionId} 同时由平台「${platforms.join('」「')}」认领：判不出它是哪个平台的聊天窗口，不收录。` +
          '改配置，一个会话 id 只归一个平台',
        `claim:${sessionId}`,
      );
      return;
    }
    // 补记只认这个 id 归消息平台的适配器管的入站：WebUI 与终端往房间插话不算
    if (session && platforms[0] !== msg.platform) return;
    const adapter = getPlatformAdapters(this.caps.platform).find(a => a.platform === msg.platform);
    const scope = chatScopeOf(msg, sessionTypesOf(adapter));
    if (scope.undeclared) {
      this.warnOnce(
        `平台「${scope.platform}」没有声明类型「${scope.type}」（${sessionId}）：这个聊天窗口按多方记下。` +
          '适配器要在 sessionTypes 里声明它发出的类型名',
        `type:${scope.platform}:${scope.type}`,
      );
    } else if (msg.sessionType === undefined && scope.multiParty) {
      this.warnOnce(
        `平台「${scope.platform}」的消息没带类型名（${sessionId}）：这个聊天窗口按类型「${scope.type}」、多方记下。` +
          '适配器要在消息上带类型名',
        `untyped:${scope.platform}`,
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
      ...(claimants[0] ? { originInstance: claimants[0].id } : {}),
    };
    if (session) await this.backfillRoom(session, nativeName, origin);
    else await this.recordRoom(sessionId, nativeName, origin);
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
      const entry = await resolvePlatformBySession(this.caps.platform, session.id, this.caps.logger.use);
      if (!entry || this.sessions.get(session.id) !== session) return;
      session.originInstance = entry.id;
      this.markDirty();
      await this.caps.events.use.emit('session:updated', session);
    } finally {
      this.resolving.delete(session);
    }
  }

  // ---- 取别的会话的东西 ----

  canTake(currentId: string, targetId: string, principal?: { platform: string; userId: string }): TakeVerdict {
    if (currentId === targetId) return { ok: true };
    const current = rootSessionOf(this.sessions.get(currentId), this.lookup);
    const target = rootSessionOf(this.sessions.get(targetId), this.lookup);
    // 同一棵会话树：两个判不出的根会话（都是 undefined）不算相同
    if (current && current === target) return { ok: true };
    const from = platformOf(current);
    const to = platformOf(target);
    if (!current || !target || from === undefined || to === undefined) return { ok: false, reason: TAKE_UNKNOWN };
    const values = this.take.get(currentId, { platform: from });
    // 范围写坏了的按本会话
    if (values.takeScope !== 'platform' && values.takeScope !== 'all') return { ok: false, reason: t('scopeSession') };
    if (values.takeScope === 'platform' && from !== to) return { ok: false, reason: t('scopePlatform') };
    // 机器人账号只在同一平台里有意义：跨平台由范围管
    const ownBot = current.originChat?.selfId;
    const chat = target.originChat;
    const otherBot = from === to && ownBot !== undefined && chat?.selfId !== undefined && chat.selfId !== ownBot;
    if (otherBot && values.takeCrossBot !== true) return { ok: false, reason: t('crossBot') };
    if (chat?.multiParty) {
      return values.takeOtherGroups === true ? { ok: true } : { ok: false, reason: t('otherGroups') };
    }
    if (this.ownChat(target, principal)) return { ok: true };
    return values.takeOthersPrivate === true ? { ok: true } : { ok: false, reason: t('othersPrivate') };
  }

  /**
   * 一对一的目标（根会话）是不是授权身份自己与她的私聊。owner 的面按与 owner 的一对一，看授权身份是不是 owner；IM 窗口按
   * oneToOneWith，出生平台的适配器（与收录时判一对一用的同一个）明确声明了它的类型为一对一才算。权限服务不在时没有人是 owner
   */
  private ownChat(root: SessionInfo, principal: { platform: string; userId: string } | undefined): boolean {
    const authority = this.caps.authority.present ? this.caps.authority.use : undefined;
    const isOwner = authority && ((platform: string, userId: string) => authority.isOwner(platform, userId));
    if (root.originPlatform === undefined) {
      return Boolean(principal?.userId && isOwner?.(principal.platform, principal.userId));
    }
    const adapter = getPlatformAdapters(this.caps.platform).find(a => a.platform === root.originPlatform);
    const declared = adapter?.sessionTypes?.find(type => type.name === root.originChat?.type)?.multiParty === false;
    return oneToOneWith(root, principal, declared, isOwner);
  }

  // ---- CRUD ----

  async createSession(opts?: NewSessionFields, creation?: SessionCreation): Promise<SessionInfo> {
    if (creation && opts?.parentId)
      throw new Error('建档专用参数只给根会话：子会话按根会话取创建来源、所属工作区与绑定');
    const created = creation ? this.creationFields(creation) : {};
    // 子会话的 id 同样不带父会话的 id：平台按会话 id 认领窗口，子会话没有窗口。撞上已有的会话就重抽
    let id: string;
    do id = `session-${crypto.randomUUID().slice(0, 8)}`;
    while (this.sessions.has(id));
    const parent = opts?.parentId ? this.sessions.get(opts.parentId) : undefined;

    const now = Date.now();
    const session: SessionInfo = {
      id,
      name: opts?.name || undefined,
      title: opts?.title,
      parentId: opts?.parentId,
      children: [],
      status: opts?.status || 'active',
      createdAt: now,
      updatedAt: now,
      inputContext: opts?.inputContext,
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
    await this.caps.events.use.emit('session:created', session);
    if (parent) await this.caps.events.use.emit('session:updated', parent);
    this.caps.logger.use.info(`会话创建: ${toSource(sessionLabel(session))} (${id})`);
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

    if (updates.name !== undefined) session.name = updates.name;
    if (updates.status !== undefined) session.status = updates.status;
    if (updates.metadata !== undefined) session.metadata = { ...session.metadata, ...updates.metadata };
    session.updatedAt = Date.now();

    this.markDirty();
    await this.caps.events.use.emit('session:updated', session);
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    await this.removeAll([id]);
  }

  /**
   * 逐个删掉这些会话（各连同下面各级子会话），返回删掉的会话数。哪一处抛错都不拦住其余的，全部做完再交出：一处原样交出，几处
   * 合成一个挂着给人看的文字的 AggregateError（各级的摊平成一层）
   */
  private async removeAll(ids: readonly string[]): Promise<number> {
    const failures: unknown[] = [];
    let removed = 0;
    for (const id of ids) removed += await this.remove(id, failures);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const text = t('deleteFailed', { count: failures.length });
      throw withText(new AggregateError(failures, text.source), text);
    }
    return removed;
  }

  /** 删掉一个会话连同下面各级子会话，返回删掉的会话数（不在表里的算 0）；抛错带会话 id 告警、收进 failures，自己不抛 */
  private async remove(id: string, failures: unknown[]): Promise<number> {
    const session = this.sessions.get(id);
    if (!session) return 0;

    // 开始删除，同一步：从表里摘掉（父会话的子会话列表变了，删除之后再给它发一次 session:updated）、换代号。这之后到的同一会话的
    // 入站等删除做完（见 recordInbound），是新的一代；这之前已收录、还在半路上的是旧的一代，网关交给 agent 之前、agent 交给通道
    // 之前比代号放掉、不归档
    const parent = session.parentId ? this.sessions.get(session.parentId) : undefined;
    if (parent) {
      parent.children = parent.children.filter(c => c !== id);
      parent.updatedAt = Date.now();
    }
    this.sessions.delete(id);
    this.deleted[SESSIONS].set(id, Symbol(id));
    this.markDirty();
    let done!: () => void;
    this.removing.set(id, new Promise<void>(resolve => (done = resolve)));
    this.generations.set(id, this.generationOf(id) + 1);

    // 整个删除交给 agent 的 clearing：它先按住这个会话、停下在跑的一轮并等它收尾，按住到清完，删子会话期间这个会话也不开轮。先删
    // 各级子会话（含活跃子会话），再发事件、清数据：监听方在事件里停掉这个会话在跑的东西，清数据时就不会有中途写回来的。子会话的
    // 抛错收进 failures，不拦住余下的子会话与这个会话自己的发事件、清数据、给上一级发 session:updated：这个会话已摘掉，停在半路
    // 的话它的数据不清，余下子会话的 parentId 悬空，也无法再删一次
    let removed = 1;
    const finish = async () => {
      for (const childId of [...session.children]) removed += await this.remove(childId, failures);
      await this.caps.events.use.emit('session:deleted', id);
      await this.clearDeletedSessionData(id);
    };
    try {
      await (this.caps.agent.present ? this.caps.agent.use.clearing([id], finish, '会话删除') : finish());
    } catch (err) {
      this.caps.logger.use.warn(`会话删除出错 [${id}]:`, err);
      failures.push(err);
    } finally {
      this.removing.delete(id);
      done();
    }
    if (parent) await this.caps.events.use.emit('session:updated', parent);
    this.caps.logger.use.info(`会话删除: ${toSource(sessionLabel(session))} (${id})`);
    return removed;
  }

  private async clearDeletedSessionData(id: string): Promise<void> {
    const clearData: HookContextMap['memory:clear'] = {
      scope: 'session',
      sessionId: id,
      results: [],
    };

    await this.caps.hooks.use.run('memory:clear', clearData, async () => {
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
      this.caps.logger.use.warn(
        `会话数据清理存在失败项 [${id}]: ${failed.map(r => `${r.source}: ${toSource(r.message)}`).join('; ')}`,
      );
    }
  }

  /**
   * 删掉一个会话的全部子会话（连同下面各级），不给 parentId 即删掉全部子会话；会话不在表里时什么都不删。返回这次删掉的会话数
   * （途中别处建的、删的会话不算）
   */
  async deleteChildren(parentId: string | undefined): Promise<number> {
    if (parentId !== undefined && !this.sessions.has(parentId)) return 0;
    const targets = [...this.sessions.values()].filter(s =>
      parentId === undefined ? s.parentId !== undefined : s.parentId === parentId,
    );
    return this.removeAll(targets.map(s => s.id));
  }

  // ---- 树形操作 ----

  async createChildSession(parentId: string, opts?: Omit<NewSessionFields, 'parentId'>): Promise<SessionInfo> {
    // 带 source 的注入回合（定时任务、编排）可能落在还没建档的会话上：先按 id 兜底建档再挂子会话，否则 create_subtask
    // 在这些会话里必败。兜底建档的会话没有来源字段、创建来源与名字：是房间的由之后的原生入站补记来源字段与名字
    if (!this.sessions.has(parentId)) await this.ensureSession(parentId);
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
    await this.caps.events.use.emit('session:updated', session);
  }

  async setExtraRoots(sessionId: string, extraRoots: readonly string[]): Promise<void> {
    const { root, work } = this.inWorkTree(sessionId);
    work.extraRoots = [...extraRoots];
    this.markDirty();
    await this.caps.events.use.emit('session:updated', root);
  }

  async addWorktree(sessionId: string, path: string): Promise<void> {
    const { root, work } = this.inWorkTree(sessionId);
    if (work.worktrees.includes(path)) return;
    work.worktrees.push(path);
    this.markDirty();
    await this.caps.events.use.emit('session:updated', root);
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
        targetId !== '' &&
        !chat?.multiParty &&
        (this.caps.authority.present ? this.caps.authority.use.isOwner(root.originPlatform, targetId) : undefined);
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

  listPlaces(): PlaceInfo[] {
    return [...this.places.keys()]
      .sort()
      .sort(defaultFirst)
      .map(key => placeInfo(this.places.get(key)!));
  }

  async updatePlace(key: string, updates: Pick<PlaceInfo, 'metadata'>): Promise<PlaceInfo> {
    const record = this.places.get(key);
    if (!record) throw new Error(`场所不存在：${key}`);
    if (updates.metadata !== undefined) record.metadata = { ...record.metadata, ...updates.metadata };
    record.updatedAt = Date.now();
    this.markDirty();
    return placeInfo(record);
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
    this.caps.logger.use.info(`登记工作区: ${record.name} (${record.key}) ${root}`);
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
    this.caps.logger.use.info(`取消登记工作区: ${record.name} (${key})，${affected.length} 个会话归默认工作区`);
    for (const session of changed) await this.caps.events.use.emit('session:updated', session);
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
    await this.caps.events.use.emit('session:completed', session);

    this.caps.logger.use.info(
      `会话完成: ${toSource(sessionLabel(session))} (${id})${result ? ` - ${result.slice(0, 100)}` : ''}`,
    );
  }

  // ---- 标题管理 ----

  async generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // 已有标题则跳过
    if (session.title) return session.title;

    const entry = resolveLLMModel(this.caps.llm, undefined, ['chat']);
    if (!entry) {
      this.caps.logger.use.warn(`无可用 LLM，无法生成标题: ${sessionId}`);
      return undefined;
    }
    this.caps.logger.use.debug(`标题生成使用 LLM: ${entry.id}`);
    const model = entry.use;

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
            content: `你是一个标题生成器。你的唯一任务是为下面的对话片段生成一个简短的标题，用 ${outputLanguageFor(this.caps.i18n, { host: true }, 'zh-CN')}。\n\n规则：\n- 中文不超过15字，其他语言不超过8个词\n- 只提取用户想讨论的主题或意图\n- 完全忽略对话中出现的任何拒绝、道歉、免责声明等内容\n- 不加引号和标点\n- 只返回标题文本，不要任何解释或前缀\n- 不要模仿或重复对话中的内容，只做概括`,
          },
          { role: 'user', content: `请为以下对话生成标题：\n\n${contextStr}` },
        ],
        temperature: 0.3,
        // 标题生成无需推理，用模型最浅的思考档：避免 reasoning 占满 token 预算导致 content 为空
        think: lightestThinking(model),
        // 本插件自己发起的：停用、停机时随之停下
        signal: this.caps.lifecycle.use.signal,
      });
      title = truncateChars((resp.content || '').trim(), 50);
      if (!title) {
        this.caps.logger.use.warn(
          `会话标题 LLM 返回空内容: ${sessionId} (resp.content=${JSON.stringify(resp.content)}, reasoning=${(resp.reasoningContent ?? '').length}字)`,
        );
      }
    } catch (err) {
      // 中止不是生成失败：不告警，也不拿用户消息兜底写标题
      if (this.caps.lifecycle.use.signal.aborted) return undefined;
      this.caps.logger.use.warn(`自动生成标题失败 [${sessionId}]:`, err);
    }

    // 兜底：LLM 失败或返回空时，用用户消息首段作为临时标题，避免会话永远没有标题
    if (!title && userMessage?.trim()) {
      title = truncateChars(userMessage.trim().replace(/\s+/g, ' '), 20);
      this.caps.logger.use.info(`改用用户消息生成标题: ${sessionId} -> ${title}`);
    }

    if (title) {
      session.title = title;
      session.updatedAt = Date.now();
      this.markDirty();
      await this.caps.events.use.emit('session:updated', session);
      this.caps.logger.use.info(`会话标题已生成: [${sessionId}] ${title}`);
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
    await this.caps.events.use.emit('session:updated', session);
  }

  /** 同一处只告警一次：key 缺省为这句话本身 */
  private warnOnce(message: string, key = message): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.caps.logger.use.warn(message);
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
  recordOutcome(turnId: string, outcome: TurnOutcome, error: string | TextRef | undefined): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.outcome = outcome;
    // 一句原因：agent 给的可能带上游的整段响应（字符串本身，或文字对象的参数），会随会话落盘、进子任务提醒，截短；空串当作没给
    if (outcome !== 'error' || !error) turn.error = undefined;
    else
      turn.error = typeof error === 'string' ? truncateChars(error, ERROR_MAX, '…') : truncateParams(error, ERROR_MAX);
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
    void this.caps.events.use.emit('session:updated', session);
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
    this.closed = true;
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

/**
 * 判得出的根会话的平台：IM 房间（出生平台加聊天窗口）取出生平台，owner 的面（有创建来源）取创建来源。不在会话表里的、按 id
 * 兜底建档的空记录与只记了出生平台的旧房间记录（等下一条原生入站补记）判不出
 */
function platformOf(root: SessionInfo | undefined): string | undefined {
  if (root?.originPlatform !== undefined) return root.originChat ? root.originPlatform : undefined;
  return root?.createdFrom;
}

/** 新建的场所记录：默认工作区没有名字 */
function newPlace(place: SessionPlace, name?: string, root?: string): PlaceRecord {
  const now = Date.now();
  return { ...place, name, ...(root === undefined ? {} : { root }), createdAt: now, updatedAt: now };
}

function placeInfo({ kind, key, name, metadata }: PlaceRecord): PlaceInfo {
  return { kind, key, name, ...(metadata === undefined ? {} : { metadata }) };
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
  name: isText,
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
    (value.error === undefined || asText(value.error) !== undefined),
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
    children: isTextList(record.children),
    status: SESSION_STATUSES.has(record.status),
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
 * 可选的名字（默认工作区没有）、目录与 metadata 类型不对时去掉它
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
    createdAt: isTime(record.createdAt),
    updatedAt: isTime(record.updatedAt),
  };
  const wrong = Object.keys(required).find(field => !required[field]);
  if (wrong) return { wrong };
  const dropped = [
    ...['name', 'root'].filter(field => record[field] !== undefined && !isText(record[field])),
    ...(record.metadata !== undefined && !isRecord(record.metadata) ? ['metadata'] : []),
  ];
  for (const field of dropped) delete record[field];
  return { record: record as unknown as PlaceRecord, dropped };
}

// ===== 插件入口 =====

const uses = {
  /** 会话档案与消息历史的唯一落点：没有 memory 就没有会话管理 */
  memory,
  /**
   * 删除会话清数据时经它的 clearing 按住这个会话；另为 agent:* 钩子的键类型。
   * 第一方栈由 core 关停编排（optional 环成员先全部 drain）与回合结束时的收口处理；
   * 此处 onDrain 兜的是未装 agent 或钩子未挂上的路径。
   */
  agent: optional(agent),
  /** 自动标题的模型来源（没有 LLM 时退回用户消息首段） */
  llm: optional(llm),
  /**
   * 自动标题的输出语言：取全局语言（读者是 owner），缺席时按中文。plugin-i18n 也以 optional 用会话管理，
   * 两边成可选环
   */
  i18n: optional(i18n),
  /** 房间建档时问认领者、取平台的类型声明记下聊天窗口；解析接管房间的适配器实例（originInstance） */
  platform: optional(platform),
  /**
   * owner 的 IM 私聊在默认工作区：placeOf 按它认对端是不是 owner，与房间类别同一判据。plugin-authority 也以 optional
   * 用会话管理，两边成可选环；缺席时认不出 owner，一对一窗口按窗口算
   */
  authority: optional(authority),
  /**
   * 按会话读取别的会话的范围与三个开关；缺席时取插件配置里的值。plugin-session-settings 以 required 用会话管理：这边可选，
   * 读取器的登记随它上线补上
   */
  sessionFields: optional(sessionFields),
  /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
  document: optional(ownHostConfig),
  config,
  events,
  hooks,
  lifecycle,
  logger,
  provide,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-session-manager',
  displayName: t('displayName'),
  subsystem: 'session',
  configSchema,
  provides: [sessionManager],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { memory, events, hooks, lifecycle, logger, provide } = caps;

  const manager = new SessionManager(caps, caps.sessionFields.use.fields(configSchema, caps));

  // 会话表跟随 memory 胜者：首次挂接即加载；运行中胜者换人时先写回旧后端再读新后端
  memory.follow(instance => manager.attach(instance));
  await manager.loading;
  // 读表（含重试等待）期间停用或停机的，不再发布服务与登记
  lifecycle.use.signal.throwIfAborted();

  // 注册服务
  provide.use(sessionManager, manager, { label: t('displayName') });

  // ===== IM 房间收录 =====
  // 原生入站的收录与补记见 recordInbound；网关在入站相位之前也等它，同一会话共用同一次
  events.use.on('inbound:message', msg => manager.recordInbound(msg));

  // ===== 清空连带删除子会话 =====
  // 会话的消息历史清成功（结果里 type 为 context 的行都成功了）之后，它的子会话一并删除：范围为 session 删这个会话的，为 all
  // 删全部子会话，删了的在结果里加一行。只清别的类型、消息历史没清成时不删；会话不在表里（删除会话自己触发的那次清理，会话已
  // 先从表里摘掉）时什么都不做
  hooks.use.middleware('memory:clear', async (data, next) => {
    await next();
    if (!historyCleared(data)) return;
    const deleted = await manager.deleteChildren(data.scope === 'all' ? undefined : data.sessionId);
    if (deleted > 0) {
      data.results.push({
        source: 'session-manager',
        type: 'context',
        success: true,
        message: t('childrenDeleted', { count: deleted }),
      });
    }
  });

  // ===== 会话状态 =====
  // 回合真正开始时（agent:turn:before）才翻 active，归档的不翻：群里只有消息、她没开口的房间不显示「进行中」
  //（触发判定在入站相位，挡下的消息到不了这里）。同一个中间件在 finally 里记下这一轮并收口，根会话与子会话一样，这是
  // 唯一的收口：next() 返回时整轮已执行完毕、agent:turn:after 也已执行（agent 只在这个钩子的默认动作里发它），结局已经记下；
  // 后面的中间件不调 next() 或抛错时 agent 不发回合收尾，同样由这里兜住。按回合 id 登记在飞的回合，会话里没有别的在飞回合
  // 时才收口；回合中途的出站（send_attachment 在工具执行中直接发）不收口。
  hooks.use.middleware('agent:turn:before', async (data, next) => {
    manager.beginTurn(data.sessionId, data.turnId);
    try {
      await next();
    } finally {
      manager.endTurn(data.turnId);
    }
  });
  hooks.use.middleware('agent:turn:after', async (data, next) => {
    manager.recordOutcome(data.turnId, data.outcome, data.error);
    await next();
  });
  // 模型调用的 token 按会话累加：对话、摘要、识图、转写的调用都带会话 id
  events.use.on('llm:usage', usage => manager.recordUsage(usage));

  // 自动标题：只给带创建来源的根会话（WebUI 新建的、终端建的）生成，在首条消息时生成、不等回复；IM 房间不生成，
  // owner 从 WebUI 往房间插话也不拿来给房间起名。异步生成，不阻塞消息处理；直接传入这条消息，不依赖历史
  /**
   * 在途的标题生成，按会话 id：同一会话同时只生成一份；收尾时等它们落定（信号已断，模型调用停在当前这一步），之后
   * onDispose 刷盘
   */
  const titling = new Map<string, Promise<unknown>>();
  events.use.on('inbound:message', (msg: IncomingMessage) => {
    const { sessionId } = msg;
    const session = manager.getSession(sessionId);
    if (!session?.createdFrom || session.title || titling.has(sessionId)) return;
    logger.use.info(`开始生成会话标题: ${sessionId}`);
    const work = manager
      .generateTitle(sessionId, msg.content)
      .catch(err => logger.use.warn('标题生成失败:', err))
      .finally(() => titling.delete(sessionId));
    titling.set(sessionId, work);
  });
  lifecycle.use.onDrain(async () => {
    while (titling.size > 0) await Promise.all(titling.values());
  }, '等在途的标题生成');

  // 关停收尾：仍 active 的会话在 onDrain 收口并落盘。
  // 第一方栈由 core 关停编排（optional 环成员先全部 drain）与回合结束时的收口处理；
  // 此处兜的是未装 agent 或钩子未挂上的路径。
  // 持久化仍走 onDispose：覆盖 bounce / unload / updateConfig 等全部拆卸路径
  // （只在全局停机触发的话，热重载即丢会话元数据）。
  // 异步收尾由编排层的 disposeAsync 等待完成；app.stop() 的拓扑逆序保证此时 memory 提供者
  // 尚未关闭，单独热重载/禁用 memory 提供者时无此保证。shutdown() 幂等：清 timer + 置 dirty + 落盘。
  lifecycle.use.onDrain(() => manager.settleActiveOnDrain(), '收口在飞会话');
  lifecycle.use.onDispose(() => manager.shutdown());

  logger.use.info('会话管理服务已启用');
}

// ----- 平台适配器接口 -----

/** 单个平台连接的状态 */
export interface PlatformConnection {
  /** 连接唯一标识 */
  id: string;
  /** 平台名称 (如 'cli', 'webui', 'onebot') */
  platform: string;
  /** 机器人自身 ID（仅协议平台使用） */
  selfId?: string;
  /** 机器人自身昵称/显示名（仅协议平台使用） */
  selfNickname?: string;
  /** 连接状态 */
  status: 'online' | 'offline' | 'connecting';
  /** 额外信息 (如 OneBot 的实现名称、版本等) */
  detail?: Record<string, unknown>;
}

/** 平台自身身份（机器人/账号），用于 prompt 注入和历史消息归档 */
export interface PlatformSelfIdentity {
  /** 平台名称 (如 'onebot', 'cli', 'webui') */
  platform: string;
  /** 平台账号 ID（协议平台通常可用） */
  selfId?: string;
  /** 平台账号昵称/显示名 */
  nickname?: string;
}

/**
 * 平台类型：一个平台里聊天窗口的一种（如 OneBot 的群与私聊）。类型名由平台自定，消息经 IncomingMessage.sessionType 带上它
 */
export interface SessionTypeDecl {
  /** 类型名：非空，不含 `:`，不是 `*`；与作用域 `平台:类型:目标` 的第二段同一套写法 */
  name: string;
  /** 多方（受众里不止机器人与对端两方）为 true，一对一为 false */
  multiParty: boolean;
}

/**
 * 平台适配器 —— 每个平台插件实现此接口
 *
 * 提供统一的平台抽象，使核心可以查询所有已接入平台的连接状态，
 * 也使其他插件可以向指定平台发送消息。
 *
 * 第三方平台接入只需实现此接口，在 uses 中声明 provide，经 `provide(platform, adapter)` 注册即可。
 */
export interface PlatformAdapter {
  /** 适配器显示名称 */
  adapterName: string;
  /** 平台标识 (如 'cli', 'webui', 'onebot', 'telegram', 'discord') */
  platform: string;
  /**
   * 这个平台的类型，消息在 IncomingMessage.sessionType 上带类型名。IM 房间建档时按它记下聊天窗口是一对一还是多方，
   * 作用域的候选也按它列。
   *
   * 不声明（没写或空列表）的平台整个算一个一对一类型 `private`（见 {@link sessionTypesOf}）。有多方会话的平台必须声明
   * 类型并在消息上带类型名：不声明的，它的群按一对一处理，任何群员都会被当成那个唯一的对端；声明了却没在消息上带类型名的，
   * 一对一的聊天也按多方处理（见 {@link resolveSessionType}）
   */
  sessionTypes?: readonly SessionTypeDecl[];
  /** 获取当前所有连接 */
  getConnections(): PlatformConnection[];
  /** 向指定 sessionId 发送纯文本消息 */
  sendMessage(sessionId: string, content: string, options?: { skipSplit?: boolean }): Promise<void>;
  /**
   * 判断该 adapter 是否能处理给定 sessionId（**路由用**）。
   *
   * - `resolvePlatformBySession(source, sid)`、`claimantsOf(source, sid)` 枚举所有 adapter 调此方法定位归属
   * - 未实现时 helper 默认 fallback 为 `sessionId.startsWith(this.platform + ':')`
   *   —— 只适合同一平台只装一个实例的适配器
   * - sessionId 不携带 platform 前缀的 adapter（如 cli 的自定义 sessionId）
   *   **必须**显式实现此方法
   * - 能装多个实例的适配器（如 onebot）**必须**实现此方法，只认自己实例的会话：
   *   前缀兜底会让第一个实例接下所有同平台会话
   *
   * 与 LLMService.supportsModel 的设计意图对称：每个 provider 自报"我接不接这个 key"，
   * 路由优先本方法，前缀只是未实现时的兜底。会话 id 的写法归适配器自己：选层、场所与会话列表都读会话记下的字段，
   * 不看 id。
   */
  canHandle?(sessionId: string): boolean | Promise<boolean>;
  /** 获取当前平台账号自身身份；多连接平台可用 sessionId 定位具体连接 */
  getSelfIdentity?(sessionId?: string): PlatformSelfIdentity | undefined;
  /**
   * 调用平台原生 API（可选，由具体适配器实现）
   *
   * 例如 OneBot 适配器通过此接口调用 set_group_ban 等 Action。
   * @param sessionId 用于定位连接的 sessionId
   * @param action    API 名称
   * @param params    API 参数
   */
  callAction?(sessionId: string, action: string, params: Record<string, unknown>): Promise<unknown>;
}

// ----- 聚合 / 路由 helper -----
//
// 所有按 sessionId 分发、按平台名汇总的逻辑都用纯函数表达，调用方传 ctx 即可，
// 没有 router facade entry，没有自递归隐患。

import type { Logger, ServiceRef } from '@aalis/core';
import { defineService } from '@aalis/core';

export interface PlatformAdapterEntry {
  instance: PlatformAdapter;
  contextId: string;
  label?: string;
}

/** 枚举所有 platform adapter 条目 */
export function getPlatformAdapterEntries(source: Pick<ServiceRef<PlatformAdapter>, 'all'>): PlatformAdapterEntry[] {
  return source.all();
}

/** 枚举所有 platform adapter 实例 */
export function getPlatformAdapters(source: ServiceRef<PlatformAdapter>): PlatformAdapter[] {
  return getPlatformAdapterEntries(source).map(e => e.instance);
}

/** 枚举所有平台名（来自 adapter.platform 字段，去重） */
export function getPlatformNames(source: ServiceRef<PlatformAdapter>): string[] {
  const names = new Set<string>();
  for (const a of getPlatformAdapters(source)) names.add(a.platform);
  return [...names];
}

/** 不声明类型的平台的那一个类型 */
const UNDECLARED_TYPES: readonly SessionTypeDecl[] = [{ name: 'private', multiParty: false }];

/**
 * 平台的类型：适配器声明的条目；没声明（没写或空列表）时整个平台算一个一对一类型 private。
 * 平台没有适配器（没装、停用）时同没声明
 */
export function sessionTypesOf(adapter: Pick<PlatformAdapter, 'sessionTypes'> | undefined): readonly SessionTypeDecl[] {
  return adapter?.sessionTypes?.length ? adapter.sessionTypes : UNDECLARED_TYPES;
}

/** 消息带的类型名按平台的类型解析的结果 */
export interface ResolvedSessionType extends SessionTypeDecl {
  /** 类型名不在平台的声明里：已按多方处理，调用方据此告警 */
  undeclared: boolean;
}

/**
 * 按平台的类型解析消息带的类型名，都是失败关闭：宁可把一对一当多方。
 * - 不带类型名：声明里有多方类型的按其中第一个（适配器漏带了类型名，调用方据消息上没有类型名告警，每个平台一次）；
 *   没声明、或声明里只有一对一类型的按 private、一对一；
 * - 声明里有的按声明，多方标记不是 false 的（漏写、写错）按多方；
 * - 声明里没有的按多方，标出 undeclared
 */
export function resolveSessionType(types: readonly SessionTypeDecl[], name: string | undefined): ResolvedSessionType {
  const multiParty = (type: SessionTypeDecl) => type.multiParty !== false;
  if (name === undefined) {
    const shared = types.find(multiParty);
    return shared
      ? { name: shared.name, multiParty: true, undeclared: false }
      : { name: 'private', multiParty: false, undeclared: false };
  }
  const declared = types.find(type => type.name === name);
  return declared
    ? { name, multiParty: multiParty(declared), undeclared: false }
    : { name, multiParty: true, undeclared: true };
}

/** 聚合所有 adapter 的连接 */
export function aggregatePlatformConnections(source: ServiceRef<PlatformAdapter>): PlatformConnection[] {
  return getPlatformAdapters(source).flatMap(a => a.getConnections());
}

/** 聚合所有 adapter 的展示详情（含 contextId / connections） */
export function aggregatePlatformDetails(source: ServiceRef<PlatformAdapter>): Array<{
  adapterName: string;
  platform: string;
  contextId: string;
  connections: PlatformConnection[];
}> {
  return getPlatformAdapterEntries(source).map(({ instance, contextId }) => ({
    adapterName: instance.adapterName,
    platform: instance.platform,
    contextId,
    connections: instance.getConnections(),
  }));
}

/**
 * 按平台名查询 adapter 自身身份：同平台装了多个实例时，取第一个认得这个会话的实例给出的身份
 * （多账号适配器按 sessionId 定位自己的连接，认不出时返回 undefined）
 */
export function getPlatformSelfIdentity(
  source: ServiceRef<PlatformAdapter>,
  platform: string,
  sessionId?: string,
): PlatformSelfIdentity | undefined {
  for (const a of getPlatformAdapters(source)) {
    if (a.platform !== platform) continue;
    const identity = a.getSelfIdentity?.(sessionId);
    if (identity) return identity;
  }
  return undefined;
}

/**
 * 这个 adapter 认不认领 sessionId：优先 `canHandle`，否则 fallback 为 `sessionId.startsWith(platform + ':')`（只适合
 * 同平台单实例的适配器）。`canHandle` 抛错按不认领，告警
 */
async function claims(
  { instance, contextId }: PlatformAdapterEntry,
  sessionId: string,
  logger?: Pick<Logger, 'warn'>,
): Promise<boolean> {
  try {
    return typeof instance.canHandle === 'function'
      ? await instance.canHandle(sessionId)
      : sessionId.startsWith(`${instance.platform}:`);
  } catch (err) {
    logger?.warn(`canHandle 抛错 [${contextId}]:`, err);
    return false;
  }
}

/**
 * 按 sessionId 找到接管它的 adapter 条目（带插件实例 id `contextId`）：按登记顺序第一个认领它的。
 * 只在部分 adapter 里找时，source 给一个只列它们的 `all`
 */
export async function resolvePlatformBySession(
  source: Pick<ServiceRef<PlatformAdapter>, 'all'>,
  sessionId: string,
  logger?: Pick<Logger, 'warn'>,
): Promise<PlatformAdapterEntry | undefined> {
  for (const entry of getPlatformAdapterEntries(source)) {
    if (await claims(entry, sessionId, logger)) return entry;
  }
  return undefined;
}

/**
 * 认领 sessionId 的全部 adapter 条目，按登记顺序：判定与 {@link resolvePlatformBySession} 相同，逐个问，不在第一个认领者
 * 处停（第一个就是它解析到的那个）。用来看出一个 id 是不是同时归几个平台
 */
export async function claimantsOf(
  source: Pick<ServiceRef<PlatformAdapter>, 'all'>,
  sessionId: string,
  logger?: Pick<Logger, 'warn'>,
): Promise<PlatformAdapterEntry[]> {
  const claimants: PlatformAdapterEntry[] = [];
  for (const entry of getPlatformAdapterEntries(source)) {
    if (await claims(entry, sessionId, logger)) claimants.push(entry);
  }
  return claimants;
}

/**
 * 没有 adapter 接管时的报错。会话 id 带平台前缀时，列出这个平台各实例的已知账号与连接状态，
 * 分得清是账号写错、账号不属于任何实例，还是连接没上来。
 */
function unroutable(source: ServiceRef<PlatformAdapter>, sessionId: string): Error {
  const prefix = sessionId.split(':')[0];
  const known = getPlatformAdapterEntries(source)
    .filter(({ instance }) => instance.platform === prefix)
    .map(({ instance, contextId }) => {
      const connections = instance.getConnections().map(c => `${c.selfId ?? '?'}(${c.status})`);
      return `${contextId}: ${connections.join('、') || '无连接'}`;
    });
  const detail = known.length > 0 ? `（已知连接：${known.join('；')}）` : '';
  return new Error(`没有 platform adapter 能处理 sessionId="${sessionId}"${detail}`);
}

/** 按 sessionId 路由发送纯文本消息 */
export async function sendPlatformMessage(
  source: ServiceRef<PlatformAdapter>,
  sessionId: string,
  content: string,
  options?: { skipSplit?: boolean },
): Promise<void> {
  const adapter = (await resolvePlatformBySession(source, sessionId))?.instance;
  if (!adapter) throw unroutable(source, sessionId);
  return adapter.sendMessage(sessionId, content, options);
}

/** 按 sessionId 路由调用平台原生 action */
export async function callPlatformAction(
  source: ServiceRef<PlatformAdapter>,
  sessionId: string,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const adapter = (await resolvePlatformBySession(source, sessionId))?.instance;
  if (!adapter) throw unroutable(source, sessionId);
  if (typeof adapter.callAction !== 'function') {
    throw new Error(`platform adapter "${adapter.adapterName}" 不支持 callAction`);
  }
  return adapter.callAction(sessionId, action, params);
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const platform = defineService<PlatformAdapter>('platform');

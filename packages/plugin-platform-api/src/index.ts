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
 * 平台适配器 —— 每个平台插件实现此接口
 *
 * 提供统一的平台抽象，使核心可以查询所有已接入平台的连接状态，
 * 也使其他插件可以向指定平台发送消息。
 *
 * 第三方平台接入只需实现此接口并通过 `ctx.provide('platform', adapter)` 注册即可。
 */
export interface PlatformAdapter {
  /** 适配器显示名称 */
  adapterName: string;
  /** 平台标识 (如 'cli', 'webui', 'onebot', 'telegram', 'discord') */
  platform: string;
  /**
   * 平台可能发出的 IncomingMessage.sessionType 枚举。
   *
   * 消费者（如 plugin-flow-control / plugin-trigger-policy）可以从中汇总出
   * 真实可选作用域，避免在 UI 上臆造不存在的选项。
   *
   * 未声明表示适配器不区分 sessionType（如 cli / webui 都是单会话）。
   */
  sessionTypes?: readonly string[];
  /** 获取当前所有连接 */
  getConnections(): PlatformConnection[];
  /** 向指定 sessionId 发送纯文本消息 */
  sendMessage(sessionId: string, content: string, options?: { skipSplit?: boolean }): Promise<void>;
  /**
   * 判断该 adapter 是否能处理给定 sessionId（**路由用**）。
   *
   * - `resolvePlatformBySession(ctx, sid)` 枚举所有 adapter 调此方法定位归属
   * - 未实现时 helper 默认 fallback 为 `sessionId.startsWith(this.platform + ':')`
   *   —— 适合 sessionId 形如 `<platform>:<...>` 的协议平台（如 onebot）
   * - sessionId 不携带 platform 前缀的 adapter（如 cli 的自定义 sessionId）
   *   **必须**显式实现此方法
   *
   * 与 LLMService.supportsModel 的设计意图对称：每个 provider 自报"我接不接这个 key"，
   * helper 不假设 key 的格式约定。
   */
  canHandle?(sessionId: string): boolean | Promise<boolean>;
  /** 获取当前平台账号自身身份；多连接平台可用 sessionId 定位具体连接 */
  getSelfIdentity?(sessionId?: string): PlatformSelfIdentity | undefined;
  /**
   * 适配器是否至少有一个可用连接
   * 默认实现：检查 getConnections() 中是否有 status === 'online'
   */
  isReady?(): boolean;
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

// ----- 平台能力声明 -----
//
// service-granularity 之后，'platform' 服务不再有 router facade；每个 adapter 直接
// 以 `ctx.provide('platform', adapter, { capabilities: [...] })` 注册，capabilities
// 同时承担**平台标识**（如 'onebot' / 'cli' / 'webui'）和**消息能力**（如 'text' /
// 'image' / 'voice' / 'group-chat'）双重语义。下游消费者按需用
// `ctx.getAllServices('platform', ['text','image'])` 静态过滤。
//
// 注：此处仅声明"通用消息能力"集合；平台标识本身（onebot/cli/webui/...）由各
// adapter 在注册时自行附加。

export interface PlatformCapabilityRegistry {
  Text: 'text';
  Image: 'image';
  Voice: 'voice';
  Video: 'video';
  File: 'file';
  Forward: 'forward';
  GroupChat: 'group-chat';
  PrivateChat: 'private-chat';
  CallAction: 'call-action';
}

export type PlatformCapability = PlatformCapabilityRegistry[keyof PlatformCapabilityRegistry];

export const PlatformCapabilities = {
  Text: 'text',
  Image: 'image',
  Voice: 'voice',
  Video: 'video',
  File: 'file',
  Forward: 'forward',
  GroupChat: 'group-chat',
  PrivateChat: 'private-chat',
  CallAction: 'call-action',
} as const satisfies PlatformCapabilityRegistry;

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    platform: PlatformCapability | string;
  }
}

// ----- 聚合 / 路由 helper -----
//
// 取代历史上的 PlatformRouter（同名 facade）：所有按 sessionId 分发、按平台名汇总
// 的逻辑都用纯函数表达，调用方传 ctx 即可，没有 entry，没有自递归隐患。

import type { Context } from '@aalis/core';

export interface PlatformAdapterEntry {
  instance: PlatformAdapter;
  contextId: string;
  capabilities: string[];
  label?: string;
}

/** 枚举所有 platform adapter 条目；可选按 capabilities 过滤 */
export function getPlatformAdapterEntries(ctx: Context, requiredCaps?: readonly string[]): PlatformAdapterEntry[] {
  return ctx
    .getAllServices<PlatformAdapter>('platform', requiredCaps)
    .filter(e => typeof e.instance?.getConnections === 'function');
}

/** 枚举所有 platform adapter 实例 */
export function getPlatformAdapters(ctx: Context, requiredCaps?: readonly string[]): PlatformAdapter[] {
  return getPlatformAdapterEntries(ctx, requiredCaps).map(e => e.instance);
}

/** 枚举所有平台名（来自 adapter.platform 字段，去重） */
export function getPlatformNames(ctx: Context): string[] {
  const names = new Set<string>();
  for (const a of getPlatformAdapters(ctx)) names.add(a.platform);
  return [...names];
}

/** 聚合所有 adapter 的连接 */
export function aggregatePlatformConnections(ctx: Context): PlatformConnection[] {
  return getPlatformAdapters(ctx).flatMap(a => a.getConnections());
}

/** 聚合所有 adapter 的展示详情（含 contextId / capabilities / connections） */
export function aggregatePlatformDetails(ctx: Context): Array<{
  adapterName: string;
  platform: string;
  contextId: string;
  capabilities: string[];
  connections: PlatformConnection[];
}> {
  return getPlatformAdapterEntries(ctx).map(({ instance, contextId, capabilities }) => ({
    adapterName: instance.adapterName,
    platform: instance.platform,
    contextId,
    capabilities: [...capabilities],
    connections: instance.getConnections(),
  }));
}

/** 按平台名查询 adapter 自身身份 */
export function getPlatformSelfIdentity(
  ctx: Context,
  platform: string,
  sessionId?: string,
): PlatformSelfIdentity | undefined {
  for (const a of getPlatformAdapters(ctx)) {
    if (a.platform !== platform) continue;
    return a.getSelfIdentity?.(sessionId);
  }
  return undefined;
}

/**
 * 按 sessionId 找到接管它的 adapter；优先 `canHandle`，否则 fallback 为
 * `sessionId.startsWith(platform + ':')`（适合协议类平台）。
 */
export async function resolvePlatformBySession(ctx: Context, sessionId: string): Promise<PlatformAdapter | undefined> {
  const logger = ctx.logger.child('platform');
  for (const { instance, contextId } of getPlatformAdapterEntries(ctx)) {
    try {
      const ok =
        typeof instance.canHandle === 'function'
          ? await instance.canHandle(sessionId)
          : sessionId.startsWith(`${instance.platform}:`);
      if (ok) return instance;
    } catch (err) {
      logger.warn(`canHandle 抛错 [${contextId}]:`, err);
    }
  }
  return undefined;
}

/** 按 sessionId 路由发送纯文本消息 */
export async function sendPlatformMessage(
  ctx: Context,
  sessionId: string,
  content: string,
  options?: { skipSplit?: boolean },
): Promise<void> {
  const adapter = await resolvePlatformBySession(ctx, sessionId);
  if (!adapter) throw new Error(`没有 platform adapter 能处理 sessionId="${sessionId}"`);
  return adapter.sendMessage(sessionId, content, options);
}

/** 按 sessionId 路由调用平台原生 action */
export async function callPlatformAction(
  ctx: Context,
  sessionId: string,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const adapter = await resolvePlatformBySession(ctx, sessionId);
  if (!adapter) throw new Error(`没有 platform adapter 能处理 sessionId="${sessionId}"`);
  if (typeof adapter.callAction !== 'function') {
    throw new Error(`platform adapter "${adapter.adapterName}" 不支持 callAction`);
  }
  return adapter.callAction(sessionId, action, params);
}

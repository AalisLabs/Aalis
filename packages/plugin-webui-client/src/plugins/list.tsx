import type { UnmetService } from '@aalis/api-doctor';
import type { PluginBlockers } from '@aalis/api-webui';
import type { ConfigSchema } from '@aalis/schema-config';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection } from '../connection';
import { getJson, isRecord } from '../rest';

// 插件列表：整页取一份，插件登记表变了（plugins.changed）或管理连接重连后重取。插件区、各处的插件显示名、
// 「会话服务未启用」与页面占位的去处都读它

export type PluginState = 'pending' | 'activating' | 'active' | 'disabled' | 'disposed' | 'error';

const STATES: ReadonlySet<string> = new Set<PluginState>([
  'pending',
  'activating',
  'active',
  'disabled',
  'disposed',
  'error',
]);

/** GET /api/plugins 的一项（一个插件实例）；没起来的原因（缺、在等、待配置）照契约 */
export interface PluginRow extends PluginBlockers {
  /** 插件包名：同一插件的几个实例按它合在一起 */
  name: string;
  instanceId: string;
  displayName?: string;
  version?: string;
  /** 插件声明的子系统，没声明的不给 */
  subsystem?: string;
  state: PluginState;
  error?: string;
  /** 提供这个界面：不能从界面停用或卸载 */
  self?: boolean;
  /** 旧实例超过宽限仍未停下：停下之前不起新实例 */
  lingering?: boolean;
  reusable: boolean;
  provides: string[];
  requiredServices: string[];
  optionalServices: string[];
  /** 本插件偏好：服务名 → 偏好的提供者（contextId），只有设了的 */
  servicePreferences: Record<string, string>;
  tools: string[];
  commands: string[];
  extends?: { events?: string[]; hooks?: string[] };
  /** 配置文件里有这个实例的配置段（空段也算） */
  configSection: boolean;
  /** 配置文档里这一段：密钥字段上是引用 */
  config: Record<string, unknown>;
  configSchema?: ConfigSchema;
  defaultConfig: Record<string, unknown>;
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** 文字数组：不是数组时是空的，不是文字的项丢掉 */
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isString) : []);

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** 根的字段按种类核；服务端比客户端新时的根这里不认识，只核有种类，写兜底的说明（见 status.ts 的 rootText） */
function rootOk(root: Record<string, unknown>): boolean {
  switch (root.kind) {
    case 'error':
      return isString(root.instance) && (root.error === undefined || isString(root.error));
    case 'disabled':
    case 'starting':
    case 'lingering':
      return isString(root.instance);
    case 'withdrawn':
      return isString(root.instance) && isString(root.service);
    case 'unprovided':
      return isString(root.service);
    case 'cycle':
      return Array.isArray(root.instances) && root.instances.every(isString);
    default:
      return isString(root.kind);
  }
}

/**
 * 缺与在等的各条，插件列表与「需要处理」的插件项共用：形状不对时没有（插件列表整张不认，「需要处理」只丢这一项），
 * 免得画出半截的链；没给时是空的
 */
export function unmetOf(value: unknown): UnmetService[] | undefined {
  if (value === undefined) return [];
  const ok =
    Array.isArray(value) &&
    value.every(
      item =>
        isRecord(item) &&
        isString(item.service) &&
        Array.isArray(item.chain) &&
        item.chain.every(isString) &&
        isRecord(item.root) &&
        rootOk(item.root),
    );
  return ok ? (value as UnmetService[]) : undefined;
}

function parseRow(row: unknown): PluginRow {
  if (!isRecord(row) || typeof row.name !== 'string' || typeof row.instanceId !== 'string') {
    throw new Error('插件列表里有一项不是预期的形状');
  }
  if (typeof row.state !== 'string' || !STATES.has(row.state)) throw new Error(`插件 ${row.instanceId} 的状态认不出`);
  const lacking = unmetOf(row.lacking);
  const waiting = unmetOf(row.waiting);
  if (!lacking || !waiting) throw new Error(`插件 ${row.instanceId} 缺的服务认不出`);
  const extended = isRecord(row.extends) ? row.extends : undefined;
  return {
    name: row.name,
    instanceId: row.instanceId,
    displayName: text(row.displayName),
    version: text(row.version),
    subsystem: text(row.subsystem),
    state: row.state as PluginState,
    error: text(row.error),
    self: row.self === true,
    lingering: row.lingering === true,
    reusable: row.reusable === true,
    provides: strings(row.provides),
    requiredServices: strings(row.requiredServices),
    optionalServices: strings(row.optionalServices),
    servicePreferences: isRecord(row.servicePreferences)
      ? Object.fromEntries(
          Object.entries(row.servicePreferences).filter((entry): entry is [string, string] => isString(entry[1])),
        )
      : {},
    lacking,
    waiting,
    unconfigured: strings(row.unconfigured),
    tools: strings(row.tools),
    commands: strings(row.commands),
    extends: extended && { events: strings(extended.events), hooks: strings(extended.hooks) },
    configSection: row.configSection === true,
    config: isRecord(row.config) ? row.config : {},
    configSchema: isRecord(row.configSchema) ? (row.configSchema as ConfigSchema) : undefined,
    defaultConfig: isRecord(row.defaultConfig) ? row.defaultConfig : {},
  };
}

function parse(body: unknown): { plugins: PluginRow[]; secretRefCounts: Record<string, number> } {
  if (!isRecord(body) || !Array.isArray(body.plugins)) throw new Error('插件列表的回应不是预期的形状');
  const counts = isRecord(body.secretRefCounts) ? body.secretRefCounts : {};
  return {
    plugins: body.plugins.map(parseRow),
    secretRefCounts: Object.fromEntries(
      Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    ),
  };
}

interface Plugins {
  /** 没取到之前为 undefined；重取失败时留着上一次的 */
  plugins?: readonly PluginRow[];
  /** 配置文档里每个密钥键被引用的处数 */
  secretRefCounts: Readonly<Record<string, number>>;
  error?: Error;
  /** 重取，等最新的一次取回或失败后落定（这次被后来的作废时接着等后来的） */
  refresh(): Promise<void>;
}

const Context = createContext<Plugins | undefined>(undefined);

export function usePlugins(): Plugins {
  const plugins = useContext(Context);
  if (!plugins) throw new Error('只能在 PluginsProvider 里取插件列表');
  return plugins;
}

export function PluginsProvider({ children }: { children: ReactNode }) {
  const { admin } = useConnection();
  const [state, setState] = useState<{
    plugins?: PluginRow[];
    secretRefCounts: Record<string, number>;
    error?: Error;
  }>({ secretRefCounts: {} });

  // 新的一次取数作废还在路上的上一次；等着的调用方接着等新的那次，落定时拿到的就是最新的列表
  const inflight = useRef<{ controller: AbortController; settled: Promise<void> }>(undefined);
  const refresh = useCallback(async () => {
    inflight.current?.controller.abort();
    const controller = new AbortController();
    const settled = (async () => {
      try {
        const fetched = parse(await getJson('/api/plugins', controller.signal));
        if (!controller.signal.aborted)
          setState({ plugins: fetched.plugins, secretRefCounts: fetched.secretRefCounts });
      } catch (error) {
        if (!controller.signal.aborted) setState(current => ({ ...current, error: error as Error }));
      }
    })();
    inflight.current = { controller, settled };
    let waited: Promise<void> | undefined;
    while (inflight.current && waited !== inflight.current.settled) {
      waited = inflight.current.settled;
      await waited;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offs = [admin.on('plugins.changed', () => void refresh()), admin.onReconnect(() => void refresh())];
    return () => {
      for (const off of offs) off();
      inflight.current?.controller.abort();
    };
  }, [admin, refresh]);

  const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** 会话协议的服务名（契约 api-session-protocol 的 sessionProtocol） */
export const SESSION_PROTOCOL = 'session-protocol';

/** 对话模型的服务名与对话能力（契约 api-llm 的 llm 服务与 LLMCapabilities.Chat） */
export const LLM = 'llm';
export const CHAT = 'chat';

/** 包管理的服务名（契约 api-package-manager 的 packageManager） */
export const PACKAGE_MANAGER = 'package-manager';

/** 按服务名找提供它的插件实例（插件列表的 provides，不认插件名）；插件列表没取到或没有提供者时为 undefined */
export function useProvider(service: string): string | undefined {
  return usePlugins().plugins?.find(plugin => plugin.provides.includes(service))?.instanceId;
}

/** 提供这个界面的插件实例：界面自己的接口出了错，看它的日志；插件列表没取到时为 undefined */
export function useHost(): string | undefined {
  return usePlugins().plugins?.find(plugin => plugin.self)?.instanceId;
}

/** 市场的装卸更新没成时看谁的日志：npm 的输出与原因记在提供包管理服务的实例那里；没有它时请求错在提供界面的实例 */
export function usePackageManager(): string | undefined {
  const host = useHost();
  return useProvider(PACKAGE_MANAGER) ?? host;
}

/** 插件实例的显示名：显示名，没有时是包名 */
export const labelOf = (row: Pick<PluginRow, 'name' | 'displayName'>): string => row.displayName ?? row.name;

/** 按实例找插件列表里的一行：链上的显示名与根插件的待配置项从它取；插件列表没取到时都找不到 */
export function useFindPlugin(): (instance: string) => PluginRow | undefined {
  const { plugins } = usePlugins();
  return useMemo(() => {
    const byInstance = new Map((plugins ?? []).map(row => [row.instanceId, row]));
    return (instance: string) => byInstance.get(instance);
  }, [plugins]);
}

/** 实例 id → 包名与显示名：会话设置「高级」里的分组名、用量里按插件合并的行名、插件前端的出处都取它 */
export function usePluginNames(): {
  instances: ReadonlyMap<string, { name: string; label: string }>;
  error?: Error;
} {
  const { plugins, error } = usePlugins();
  const instances = useMemo(
    () => new Map((plugins ?? []).map(row => [row.instanceId, { name: row.name, label: labelOf(row) }])),
    [plugins],
  );
  return { instances, error };
}

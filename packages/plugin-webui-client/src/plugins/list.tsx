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

/** GET /api/plugins 的一项（一个插件实例） */
export interface PluginRow {
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
  reusable: boolean;
  provides: string[];
  requiredServices: string[];
  optionalServices: string[];
  /** 此刻没有提供者的 required 服务 */
  missing: string[];
  tools: string[];
  commands: string[];
  extends?: { events?: string[]; hooks?: string[] };
  /** 配置文档里这一段：密钥字段上是引用 */
  config: Record<string, unknown>;
  configSchema?: ConfigSchema;
  defaultConfig: Record<string, unknown>;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function parseRow(row: unknown): PluginRow {
  if (!isRecord(row) || typeof row.name !== 'string' || typeof row.instanceId !== 'string') {
    throw new Error('插件列表里有一项不是预期的形状');
  }
  if (typeof row.state !== 'string' || !STATES.has(row.state)) throw new Error(`插件 ${row.instanceId} 的状态认不出`);
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
    reusable: row.reusable === true,
    provides: strings(row.provides),
    requiredServices: strings(row.requiredServices),
    optionalServices: strings(row.optionalServices),
    missing: strings(row.missing),
    tools: strings(row.tools),
    commands: strings(row.commands),
    extends: extended && { events: strings(extended.events), hooks: strings(extended.hooks) },
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

/** 按服务名找提供它的插件实例（插件列表的 provides，不认插件名）；插件列表没取到或没有提供者时为 undefined */
export function useProvider(service: string): string | undefined {
  return usePlugins().plugins?.find(plugin => plugin.provides.includes(service))?.instanceId;
}

/** 提供这个界面的插件实例：界面自己的接口出了错，看它的日志；插件列表没取到时为 undefined */
export function useHost(): string | undefined {
  return usePlugins().plugins?.find(plugin => plugin.self)?.instanceId;
}

/** 插件实例的显示名：显示名，没有时是包名 */
export const labelOf = (row: Pick<PluginRow, 'name' | 'displayName'>): string => row.displayName ?? row.name;

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

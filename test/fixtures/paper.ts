import { type CheckResult, type CheckSpec, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import { type GatewayService, gateway, windowKey } from '../../packages/api-gateway/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import { type EgressReport, type RemoteAgentProvider, remoteAgent } from '../../packages/api-remote-agent/src/index.js';
import {
  placeKind,
  rootSessionOf,
  type SessionInfo,
  type SessionManagerService,
  type SessionPlace,
  sessionKind,
  sessionManager,
} from '../../packages/api-session-manager/src/index.js';
import {
  type SessionChain,
  type SessionPlacement,
  type SessionSettingsLayer,
  sessionSettings,
} from '../../packages/api-session-settings/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import {
  type RegisteredTool,
  type ToolCallContext,
  type ToolGroupInfo,
  tools,
} from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, events, LogHub, provide, services } from '../../packages/core/src/index.js';
import paperPlugin from '../../packages/plugin-paper/src/index.js';
import type { PaperLedger } from '../../packages/plugin-paper/src/ledger.js';
import type {
  IncomingMessage,
  OutboundDeliveryResult,
  OutgoingMessage,
} from '../../packages/schema-message/src/index.js';
import { registerHubs } from './hubs.js';
import { type PageHost, pageHost } from './page-host.js';
import { storedRoom } from './rooms.js';

// ════════════════════════════════════════════════════════════
// 白纸枢纽的测试台：真实 App 装载 plugin-paper，周边一律替身——
// - 远端代理：每个替身是一个带名字的提供者插件（实例 id 即白纸配置里写的类型）；
// - 会话管理：会话记录按会话 id 现造，另可指定哪些会话是子会话；OneBot 写法的房间 id 带上收录时记下的来源字段；
// - 会话设置：本插件六项的平台档、平台类型档与场所的值按参考实现的口径交给读取器（解析在读取器里）；全局层是
//   插件配置；
// - storage：pluginData 与 paper 两个根的内存实现，文件表可跨「重启」复用；
// - tools / gateway / doctor：记下登记的工具与出站消息，诊断项按需运行；网关替身像目标适配器一样填 delivery，
//   缺省立即确认收下；
// - webui-server：真实的页面登记表（page-host.ts），页面经质量门槛登记、数据源与动作经闸门调用；
// - 钩子与贡献点用默认提供者；入站消息（宿主通知）只记下，没有网关与 agent 消费。
// - 日志：每个测试台一个独立的 LogHub，warn 与 error 记进 logs。
// 装好后 app.start()，与宿主一样发出 app:started。不连任何真实服务。
// ════════════════════════════════════════════════════════════

export const LEDGER_URI = 'pluginData:/paper/ledger.json';
export const ROOM = 'onebot:10000:group:20001';
export const ROOM2 = 'onebot:10000:group:20002';
export const PAPER = 'zz-paper';
export const REMOTE = 'zz-remote-a';

/** 真人当面发起的回合：inbound 存在、source 缺省 */
export function human(userId = '30001', sessionId = ROOM): ToolCallContext {
  return { sessionId, platform: 'onebot', userId, inbound: {} };
}

export interface FakeRemote extends RemoteAgentProvider {
  readyCalls: number;
  cancelled: Array<{ agentId: string; runId: string }>;
}

/**
 * 替身提供者：ready 按 accountKey 回（给 Error 则抛出），其余未编排的方法一调就抛。运行驱动调到它们时
 * 按临时故障退避或记一条错误，任务停在队列里，所以受理、查状态、取消这些用例看到的队列不会被驱动挪动。
 * 要让任务真的跑起来用 paper-remote.ts 的 ScriptedRemote。
 */
export function fakeRemote(
  opts: { isolation?: 'shared' | 'per-agent'; egress?: EgressReport; accountKey?: string | Error } = {},
): FakeRemote {
  const unused = (name: string) => () => {
    throw new Error(`替身提供者未编排 ${name}`);
  };
  const fake: FakeRemote = {
    readyCalls: 0,
    cancelled: [],
    transcriptIsolation: opts.isolation ?? 'shared',
    layout: { workDir: '/work', outDir: '/work/out', bundlePath: '/work/bundle.tar.gz', policyNotes: [] },
    egress: async () => opts.egress ?? { mode: 'allowlist', source: 'owner-config' },
    async ready() {
      fake.readyCalls++;
      const key = opts.accountKey ?? 'acct-1';
      if (key instanceof Error) throw key;
      return { accountKey: key };
    },
    async cancelRun(agentId, runId) {
      fake.cancelled.push({ agentId, runId });
    },
    mintAgentId: unused('mintAgentId'),
    createAgent: unused('createAgent'),
    startRun: unused('startRun'),
    followRun: unused('followRun'),
    getRun: unused('getRun'),
    listRuns: unused('listRuns'),
    runCost: unused('runCost'),
    collectArtifacts: unused('collectArtifacts'),
    bundleLink: unused('bundleLink'),
    archiveAgent: unused('archiveAgent'),
    unarchiveAgent: unused('unarchiveAgent'),
    deleteAgent: unused('deleteAgent'),
    listAgents: unused('listAgents'),
  };
  return fake;
}

/** 文件表：键是完整 URI；账本以字符串存，白纸根里的成品以字节存 */
export type PaperFiles = Map<string, string | Uint8Array>;

const notFound = (uri: string) => Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
const sizeOf = (value: string | Uint8Array) =>
  typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;

/**
 * pluginData 与 paper 两个根的内存 storage：读写、列目录、stat、按前缀删目录；不存在的一律抛 ENOENT。
 * 目录不单独存，有文件在它下面就算存在。
 */
export function memoryStorage(files: PaperFiles): StorageService {
  const roots = ['pluginData', 'paper'].map(name => ({
    name,
    label: `${name}(内存)`,
    kind: name,
    browsable: true,
    readable: true,
    writable: true,
    deletable: true,
  }));
  const under = (uri: string) => `${uri.replace(/\/+$/, '')}/`;
  const rootOf = (uri: string) => roots.find(r => uri.startsWith(`${r.name}:`)) ?? roots[0];
  return {
    listRoots: () => roots,
    async readFile(uri: string, encoding?: BufferEncoding) {
      const value = files.get(uri);
      if (value === undefined) throw notFound(uri);
      const bytes = Buffer.from(value);
      return encoding ? bytes.toString(encoding) : bytes;
    },
    async writeFile(uri: string, data: string | Buffer) {
      files.set(uri, typeof data === 'string' ? data : new Uint8Array(data));
    },
    async stat(uri: string) {
      const value = files.get(uri);
      const name = uri.split('/').pop() ?? '';
      if (value !== undefined) return { name, path: uri, uri, isDirectory: false, size: sizeOf(value) };
      if ([...files.keys()].some(k => k.startsWith(under(uri)))) {
        return { name, path: uri, uri, isDirectory: true, size: 0 };
      }
      throw notFound(uri);
    },
    async list(uri: string) {
      const base = under(uri);
      const entries = new Map<string, { isDirectory: boolean; size: number }>();
      for (const [key, value] of files) {
        if (!key.startsWith(base)) continue;
        const [head, ...rest] = key.slice(base.length).split('/');
        entries.set(
          head,
          rest.length > 0 ? { isDirectory: true, size: 0 } : { isDirectory: false, size: sizeOf(value) },
        );
      }
      if (entries.size === 0) throw notFound(uri);
      return {
        root: rootOf(uri),
        path: uri,
        entries: [...entries].map(([name, e]) => ({
          name,
          path: `${base}${name}`,
          uri: `${base}${name}`,
          isDirectory: e.isDirectory,
          size: e.size,
          mtime: '',
          ext: '',
        })),
      };
    },
    async delete(uri: string) {
      const hits = [...files.keys()].filter(k => k === uri || k.startsWith(under(uri)));
      if (hits.length === 0) throw notFound(uri);
      for (const key of hits) files.delete(key);
    },
  } as unknown as StorageService;
}

/**
 * session-manager 替身回的会话档：OneBot 写法的房间 id（四段）带上收录时记下的出生平台与聊天窗口（与预置会话表的
 * storedRoom 相同），种类按父会话与出生平台推出，与参考实现同一口径
 */
export function sessionInfoOf(id: string, parentId?: string): SessionInfo {
  const { originPlatform, originChat } =
    parentId === undefined && id.split(':').length >= 4
      ? storedRoom(id)
      : { originPlatform: undefined, originChat: undefined };
  const info = {
    id,
    name: id,
    parentId,
    children: [],
    status: 'active' as const,
    createdAt: 0,
    updatedAt: 0,
    ...(originPlatform === undefined
      ? {}
      : { originPlatform: originPlatform as string, originChat: originChat as SessionInfo['originChat'] }),
  };
  return { ...info, kind: sessionKind(info) };
}

/** session-manager 替身的场所：子会话按根会话取，有聊天窗口的房间为窗口，其余为默认工作区（owner 的 IM 私聊不模拟） */
function placeOf(id: string, lookup: (id: string) => SessionInfo): SessionPlace {
  const root = rootSessionOf(lookup(id), lookup);
  const chat = root?.originChat;
  return root?.originPlatform !== undefined && chat
    ? { kind: 'window', key: windowKey({ platform: root.originPlatform, type: chat.type, targetId: chat.targetId }) }
    : { kind: 'workspace', key: 'workspace:default' };
}

/** 会话设置替身的各层（全局层是插件配置，不在这里） */
type SettingsLayers = Pick<PaperHubOptions, 'platforms' | 'platformTypes'> & {
  places: Record<string, Record<string, unknown>>;
};

/**
 * 会话设置的替身：与参考实现同一口径交出一个会话在全局之上的各层，子会话按根会话取；有出生平台的会话按出生平台取平台档，
 * 其余按入口平台取，有聊天窗口的另叠平台类型档，最后是场所（{@link placeOf}）的值。placements 扁平列出各层写过的值
 */
function settingsStandIn(layers: SettingsLayers, lookup: (id: string) => SessionInfo) {
  const groups = (): Array<{ layer: SessionSettingsLayer; values: Record<string, unknown> }> => [
    ...Object.entries(layers.platforms ?? {}).map(([platform, values]) => ({
      layer: { scope: 'platform' as const, platform },
      values,
    })),
    ...Object.entries(layers.platformTypes ?? {}).map(([key, values]) => {
      const [platform, type] = key.split('/') as [string, string];
      return { layer: { scope: 'platformType' as const, platform, type }, values };
    }),
    ...Object.entries(layers.places).map(([key, values]) => ({ layer: { scope: 'place' as const, key }, values })),
  ];
  return {
    register: () => () => {},
    chain(_plugin: string, sessionId: string, at: { platform?: string } = {}): SessionChain {
      const info = lookup(sessionId);
      const root = rootSessionOf(info, lookup);
      const platform = root?.originPlatform ?? at.platform;
      const type = root?.originChat?.type;
      const place = placeOf(sessionId, lookup);
      const parts: SessionChain['parts'] = [];
      const push = (layer: SessionChain['parts'][number]['layer'], values: Record<string, unknown> | undefined) => {
        if (values) parts.push({ layer, where: layer, values: { ...values } });
      };
      if (platform) push('platform', layers.platforms?.[platform]);
      if (platform && type) push('platformType', layers.platformTypes?.[`${platform}/${type}`]);
      push('place', layers.places[place.key]);
      return { kind: info.kind, placeKind: placeKind(place), parts };
    },
    placements: (): SessionPlacement[] =>
      groups().flatMap(({ layer, values }) =>
        Object.entries(values).map(([key, value]) => ({
          key,
          value,
          at: layer.scope === 'place' ? { layer, placeKind: placeKind(placeAt(layer.key)) } : { layer },
        })),
      ),
  };
}

/** 场所键对应的场所：窗口键（三段）是窗口，其余是工作区 */
const placeAt = (key: string): SessionPlace =>
  key.startsWith('workspace:') ? { kind: 'workspace', key } : { kind: 'window', key };

/** 空账本（与枢纽写出的结构相同），供用例预置 */
export function emptyLedger(): PaperLedger {
  return { version: 1, papers: {}, agents: {}, tasks: {}, runs: {}, spend: {}, reserves: {}, alerts: [] };
}

/** 写好的试点形态：一块具名白纸、房间开了白纸、类型对得上、房间每天 500 美分 */
export const PILOT_CONFIG = {
  globalDailyCents: 1000,
  papers: [{ name: PAPER, remoteAgentType: REMOTE, remoteAgentEgress: 'allowlist' }],
};
export const PILOT_ROOM: Record<string, unknown> = {
  paperEnabled: true,
  paperName: PAPER,
  remoteAgentTypes: [REMOTE],
  remoteAgentRoomDailyCents: 500,
};

export interface PaperHubOptions {
  config?: Record<string, unknown>;
  /**
   * 会话 id → 这个会话所在场所（窗口）写的六项（房间的六项只能设到场所为止）；缺省时 ROOM 与 ROOM2 都用 PILOT_ROOM。
   * places 给同一个场所写的同名项压过这里的
   */
  rooms?: Record<string, Record<string, unknown>>;
  /** 子会话 id → 父会话 id */
  children?: Record<string, string>;
  /** 全局层：并进插件配置的六项；缺省没有 */
  global?: Record<string, unknown>;
  /** 平台档，键为平台名；缺省没有 */
  platforms?: Record<string, Record<string, unknown>>;
  /** 平台类型档，键为 `<平台>/<类型名>`；缺省没有 */
  platformTypes?: Record<string, Record<string, unknown>>;
  /** 场所的值，键为场所键（窗口为 `平台:类型:目标`）；缺省没有 */
  places?: Record<string, Record<string, unknown>>;
  /** 会话列表里的会话 id（listSessions 的结果）；缺省没有 */
  listed?: string[];
  /** 实例 id → 替身提供者；缺省只有 REMOTE 一个 */
  remotes?: Record<string, RemoteAgentProvider>;
  /** services.prefer('remote-agent', …) 指向的实例 id */
  prefer?: string;
  /** 账本等文件；跨「重启」复用同一张表 */
  files?: PaperFiles;
  gatewayFails?: boolean;
  /**
   * 目标适配器对出站消息的确认（填进 message.delivery）；缺省立即确认收下。
   * 'unclaimed' 表示没有适配器认领，不填 delivery。
   */
  delivery?: (message: OutgoingMessage) => Promise<OutboundDeliveryResult> | 'unclaimed';
}

export interface PaperHub {
  app: App;
  files: PaperFiles;
  outbound: OutgoingMessage[];
  /** 枢纽注入的入站消息（宿主通知） */
  injected: IncomingMessage[];
  hooks: Hooks;
  /** warn 与 error 级的日志 */
  logs: Array<{ level: string; message: string }>;
  tools: Map<string, Omit<RegisteredTool, 'pluginName'>>;
  groups: Array<Omit<ToolGroupInfo, 'pluginName'>>;
  /** 白纸页与会话面板所在的页面登记表 */
  pages: PageHost;
  /** 调工具，返回原样的结果文本 */
  raw(name: string, args: Record<string, unknown>, ctx?: ToolCallContext): Promise<string>;
  /** 调结果为 JSON 的工具 */
  call(name: string, args: Record<string, unknown>, ctx?: ToolCallContext): Promise<Record<string, unknown>>;
  /** 运行枢纽登记的诊断项 */
  doctor(): Promise<CheckResult[]>;
  ledger(): PaperLedger;
  /** 停掉这一个测试台（模拟重启前的停机） */
  stop(): Promise<void>;
}

const hubs: Array<{ app: App; pages: PageHost }> = [];

/** 停掉本文件里起过的全部测试台（afterEach 里调） */
export async function stopPaperHubs(): Promise<void> {
  for (const { app, pages } of hubs.splice(0)) {
    await app.stop();
    pages.dispose();
  }
}

export async function startPaperHub(opts: PaperHubOptions = {}): Promise<PaperHub> {
  const logs: Array<{ level: string; message: string }> = [];
  const logHub = new LogHub();
  logHub.onEntry(entry => void logs.push({ level: entry.level, message: entry.message }));
  const app = new App({ name: 'T', logLevel: 'warn', logHub });
  const children = opts.children ?? {};
  const pages = pageHost({ sessions: id => sessionInfoOf(id, children[id]) });
  const hub = { app, pages };
  hubs.push(hub);
  const files: PaperFiles = opts.files ?? new Map();
  const outbound: OutgoingMessage[] = [];
  const injected: IncomingMessage[] = [];
  const registered = new Map<string, Omit<RegisteredTool, 'pluginName'>>();
  const groups: Array<Omit<ToolGroupInfo, 'pluginName'>> = [];
  const checks = new Map<string, CheckSpec>();
  const rooms = opts.rooms ?? { [ROOM]: PILOT_ROOM, [ROOM2]: PILOT_ROOM };

  await registerHubs(app);
  const host = app.bind({ provide, services, events, hooks });
  host.events.use.on('inbound:message', message => void injected.push(message));
  host.provide.use(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      registered.set(tool.definition.function.name, tool);
      return () => registered.delete(tool.definition.function.name);
    },
    registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>) {
      groups.push(group);
      return () => {};
    },
  } as never);
  const lookup = (id: string) => sessionInfoOf(id, children[id]);
  host.provide.use(sessionManager, {
    placeOf: (id: string) => placeOf(id, lookup),
    listSessions: (): SessionInfo[] => (opts.listed ?? []).map(lookup),
    getSession: lookup,
  } as unknown as SessionManagerService);
  const places: Record<string, Record<string, unknown>> = {};
  for (const [id, values] of Object.entries(rooms)) places[placeOf(id, lookup).key] = { ...values };
  for (const [key, values] of Object.entries(opts.places ?? {})) places[key] = { ...places[key], ...values };
  host.provide.use(sessionSettings, settingsStandIn({ ...opts, places }, lookup) as never);
  host.provide.use(storage, memoryStorage(files));
  host.provide.use(gateway, {
    async dispatchOutbound(message: OutgoingMessage) {
      if (opts.gatewayFails) throw new Error('网关替身：发送失败');
      outbound.push({ ...message });
      const delivery = opts.delivery ? opts.delivery(message) : Promise.resolve({ ok: true as const });
      if (delivery !== 'unclaimed') message.delivery = delivery;
    },
    async ingressMessage() {},
  } satisfies GatewayService);
  host.provide.use(doctor, {
    registerCheck(spec: CheckSpec) {
      checks.set(spec.id, spec);
      return () => checks.delete(spec.id);
    },
  } as unknown as DoctorService);
  host.provide.use(webuiServer, pages.service);

  for (const [id, provider] of Object.entries(opts.remotes ?? { [REMOTE]: fakeRemote() })) {
    await app.plugin(
      definePlugin({
        name: id,
        provides: [remoteAgent],
        uses: { provide },
        apply: ({ provide }) => void provide.use(remoteAgent, provider),
      }),
    );
  }
  if (opts.prefer) host.services.use.prefer(remoteAgent, opts.prefer);

  await app.plugin(paperPlugin, { ...(opts.config ?? PILOT_CONFIG), ...opts.global });
  await app.plugins.idle();
  const state = app.plugins.getPlugin(paperPlugin.name)?.state;
  if (state !== 'active') throw new Error(`plugin-paper 未激活（state=${state}）`);
  await app.start();

  const raw = async (name: string, args: Record<string, unknown>, ctx: ToolCallContext = human()) => {
    const tool = registered.get(name);
    if (!tool) throw new Error(`工具 ${name} 未登记`);
    const out = await tool.handler(args, ctx);
    return typeof out === 'string' ? out : out.content;
  };
  return {
    app,
    files,
    outbound,
    injected,
    hooks: host.hooks.use,
    logs,
    tools: registered,
    groups,
    pages,
    raw,
    call: async (name, args, ctx) => JSON.parse(await raw(name, args, ctx)) as Record<string, unknown>,
    async doctor() {
      const out: CheckResult[] = [];
      for (const spec of checks.values()) out.push(...[await spec.run()].flat());
      return out;
    },
    ledger: () => JSON.parse(String(files.get(LEDGER_URI) ?? 'null')) as PaperLedger,
    async stop() {
      hubs.splice(hubs.indexOf(hub), 1);
      await app.stop();
      pages.dispose();
    },
  };
}

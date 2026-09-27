import { type CheckResult, type CheckSpec, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import { type GatewayService, gateway } from '../../packages/api-gateway/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import { type EgressReport, type RemoteAgentProvider, remoteAgent } from '../../packages/api-remote-agent/src/index.js';
import {
  type SessionConfig,
  type SessionInfo,
  type SessionManagerService,
  sessionManager,
} from '../../packages/api-session-manager/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import {
  type RegisteredTool,
  type ToolCallContext,
  type ToolGroupInfo,
  tools,
} from '../../packages/api-tools/src/index.js';
import {
  type WebUIService,
  type WebuiActionHandler,
  type WebuiPage,
  webuiServer,
} from '../../packages/api-webui/src/index.js';
import { App, definePlugin, events, LogHub, provide, services } from '../../packages/core/src/index.js';
import paperPlugin from '../../packages/plugin-paper/src/index.js';
import type { PaperLedger } from '../../packages/plugin-paper/src/ledger.js';
import type { IncomingMessage, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from './hubs.js';

// ════════════════════════════════════════════════════════════
// 白纸枢纽的测试台：真实 App 装载 plugin-paper，周边一律替身——
// - 远端代理：每个替身是一个带名字的提供者插件（实例 id 即白纸配置里写的类型）；
// - 会话管理：按会话 id 给房间配置，另可指定哪些会话是子会话；
// - storage：pluginData 与 paper 两个根的内存实现，文件表可跨「重启」复用；
// - tools / gateway / doctor / webui-server：记下登记的工具、出站消息、页面与页面动作，诊断项按需运行；
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

/** 空账本（与枢纽写出的结构相同），供用例预置 */
export function emptyLedger(): PaperLedger {
  return { version: 1, papers: {}, agents: {}, tasks: {}, runs: {}, spend: {}, reserves: {}, alerts: [] };
}

/** 写好的试点形态：一块具名白纸、房间开了白纸、类型对得上、房间每天 500 美分 */
export const PILOT_CONFIG = {
  globalDailyCents: 1000,
  papers: [{ name: PAPER, remoteAgentType: REMOTE, remoteAgentEgress: 'allowlist' }],
};
export const PILOT_ROOM: SessionConfig = {
  paperEnabled: true,
  paperName: PAPER,
  remoteAgentTypes: [REMOTE],
  remoteAgentRoomDailyCents: 500,
};

export interface PaperHubOptions {
  config?: Record<string, unknown>;
  /** 会话 id → resolveConfig 的结果；缺省时 ROOM 与 ROOM2 都用 PILOT_ROOM */
  rooms?: Record<string, SessionConfig>;
  /** 子会话 id → 父会话 id */
  children?: Record<string, string>;
  /** 平台档（getPlatformProfiles 的结果）；缺省没有 */
  profiles?: Record<string, SessionConfig>;
  /** 会话列表里的会话 id → 会话自身的 config（listSessions 的结果）；缺省没有 */
  listed?: Record<string, SessionConfig>;
  /** 实例 id → 替身提供者；缺省只有 REMOTE 一个 */
  remotes?: Record<string, RemoteAgentProvider>;
  /** services.prefer('remote-agent', …) 指向的实例 id */
  prefer?: string;
  /** 账本等文件；跨「重启」复用同一张表 */
  files?: PaperFiles;
  gatewayFails?: boolean;
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
  /** 枢纽登记的 WebUI 页面 */
  pages: WebuiPage[];
  /** 调一个页面动作（owner 已过权限闸），返回原样的结果 */
  action(method: string, args?: Record<string, unknown>): Promise<unknown>;
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

const hubs: App[] = [];

/** 停掉本文件里起过的全部测试台（afterEach 里调） */
export async function stopPaperHubs(): Promise<void> {
  for (const app of hubs.splice(0)) await app.stop();
}

export async function startPaperHub(opts: PaperHubOptions = {}): Promise<PaperHub> {
  const logs: Array<{ level: string; message: string }> = [];
  const logHub = new LogHub();
  logHub.onEntry(entry => void logs.push({ level: entry.level, message: entry.message }));
  const app = new App({ name: 'T', logLevel: 'warn', logHub });
  hubs.push(app);
  const files: PaperFiles = opts.files ?? new Map();
  const outbound: OutgoingMessage[] = [];
  const injected: IncomingMessage[] = [];
  const registered = new Map<string, Omit<RegisteredTool, 'pluginName'>>();
  const groups: Array<Omit<ToolGroupInfo, 'pluginName'>> = [];
  const checks = new Map<string, CheckSpec>();
  const pages: WebuiPage[] = [];
  const actions = new Map<string, WebuiActionHandler>();
  const rooms = opts.rooms ?? { [ROOM]: PILOT_ROOM, [ROOM2]: PILOT_ROOM };
  const children = opts.children ?? {};

  await registerHubs(app);
  const host = app.bind({ provide, services, events, hooks });
  host.events.on('inbound:message', message => void injected.push(message));
  host.provide(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      registered.set(tool.definition.function.name, tool);
      return () => registered.delete(tool.definition.function.name);
    },
    registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>) {
      groups.push(group);
      return () => {};
    },
  } as never);
  host.provide(sessionManager, {
    resolveConfig: (sessionId: string) => ({ ...(rooms[sessionId] ?? {}) }),
    getPlatformProfiles: () => ({ ...(opts.profiles ?? {}) }),
    listSessions: (): SessionInfo[] =>
      Object.entries(opts.listed ?? {}).map(([id, config]) => ({
        id,
        name: id,
        children: [],
        status: 'active',
        config,
        createdAt: 0,
        updatedAt: 0,
      })),
    getSession: (id: string): SessionInfo => ({
      id,
      name: id,
      parentId: children[id],
      children: [],
      status: 'active',
      config: {},
      createdAt: 0,
      updatedAt: 0,
    }),
  } as unknown as SessionManagerService);
  host.provide(storage, memoryStorage(files));
  host.provide(gateway, {
    async dispatchOutbound(message: OutgoingMessage) {
      if (opts.gatewayFails) throw new Error('网关替身：发送失败');
      outbound.push(message);
    },
    async ingressMessage() {},
  } satisfies GatewayService);
  host.provide(doctor, {
    registerCheck(spec: CheckSpec) {
      checks.set(spec.id, spec);
      return () => checks.delete(spec.id);
    },
  } as unknown as DoctorService);
  host.provide(webuiServer, {
    getPort: () => 0,
    getHost: () => '127.0.0.1',
    getPages: () => pages.map(page => ({ ...page, pluginName: paperPlugin.name })),
    registerPage(page: WebuiPage) {
      pages.push(page);
      return () => void pages.splice(pages.indexOf(page), 1);
    },
    registerAction(method: string, handler: WebuiActionHandler) {
      actions.set(method, handler);
      return () => actions.delete(method);
    },
  } satisfies WebUIService);

  for (const [id, provider] of Object.entries(opts.remotes ?? { [REMOTE]: fakeRemote() })) {
    await app.plugin(
      definePlugin({
        name: id,
        provides: [remoteAgent],
        uses: { provide },
        apply: ({ provide }) => void provide(remoteAgent, provider),
      }),
    );
  }
  if (opts.prefer) host.services.prefer(remoteAgent, opts.prefer);

  await app.plugin(paperPlugin, opts.config ?? PILOT_CONFIG);
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
    hooks: host.hooks,
    logs,
    tools: registered,
    groups,
    pages,
    async action(method, args = {}) {
      const handler = actions.get(method);
      if (!handler) throw new Error(`页面动作 ${method} 未登记`);
      return handler(args, { platform: 'webui', userId: 'console' });
    },
    raw,
    call: async (name, args, ctx) => JSON.parse(await raw(name, args, ctx)) as Record<string, unknown>,
    async doctor() {
      const out: CheckResult[] = [];
      for (const spec of checks.values()) out.push(...[await spec.run()].flat());
      return out;
    },
    ledger: () => JSON.parse(String(files.get(LEDGER_URI) ?? 'null')) as PaperLedger,
    async stop() {
      hubs.splice(hubs.indexOf(app), 1);
      await app.stop();
    },
  };
}

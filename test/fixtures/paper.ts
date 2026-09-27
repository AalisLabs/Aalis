import { type CheckResult, type CheckSpec, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import { type GatewayService, gateway, resolveSessionOrigin } from '../../packages/api-gateway/src/index.js';
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
import { App, definePlugin, provide, services } from '../../packages/core/src/index.js';
import paperPlugin from '../../packages/plugin-paper/src/index.js';
import type { PaperLedger } from '../../packages/plugin-paper/src/ledger.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 白纸枢纽的测试台：真实 App 装载 plugin-paper，周边一律替身——
// - 远端代理：每个替身是一个带名字的提供者插件（实例 id 即白纸配置里写的类型），只编排枢纽会调的方法；
// - 会话管理：按会话 id 给房间配置，另可指定哪些会话是子会话；
// - storage：只有 pluginData 根的内存实现，文件表可跨「重启」复用；
// - tools / gateway / doctor：记下登记的工具与出站消息，诊断项按需运行。
// 不连任何真实服务。
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

/** 替身提供者：ready 按 accountKey 回（给 Error 则抛出）；枢纽这一段用不到的方法一调就抛 */
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
    egress: () => opts.egress ?? { mode: 'allowlist', source: 'owner-config' },
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

/** 只有 pluginData 根的内存 storage：读不存在的文件抛 ENOENT */
function memoryPluginData(files: Map<string, string>): StorageService {
  return {
    listRoots: () => [
      {
        name: 'pluginData',
        label: 'pluginData(内存)',
        kind: 'pluginData',
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      },
    ],
    async readFile(uri: string) {
      const value = files.get(uri);
      if (value === undefined) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      return value;
    },
    async writeFile(uri: string, data: string | Buffer) {
      files.set(uri, typeof data === 'string' ? data : data.toString('utf-8'));
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
  /** 实例 id → 替身提供者；缺省只有 REMOTE 一个 */
  remotes?: Record<string, RemoteAgentProvider>;
  /** services.prefer('remote-agent', …) 指向的实例 id */
  prefer?: string;
  /** 账本等文件；跨「重启」复用同一张表 */
  files?: Map<string, string>;
  gatewayFails?: boolean;
}

export interface PaperHub {
  app: App;
  files: Map<string, string>;
  outbound: OutgoingMessage[];
  tools: Map<string, Omit<RegisteredTool, 'pluginName'>>;
  groups: Array<Omit<ToolGroupInfo, 'pluginName'>>;
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
  const app = new App({ name: 'T', logLevel: 'error' });
  hubs.push(app);
  const files = opts.files ?? new Map<string, string>();
  const outbound: OutgoingMessage[] = [];
  const registered = new Map<string, Omit<RegisteredTool, 'pluginName'>>();
  const groups: Array<Omit<ToolGroupInfo, 'pluginName'>> = [];
  const checks = new Map<string, CheckSpec>();
  const rooms = opts.rooms ?? { [ROOM]: PILOT_ROOM, [ROOM2]: PILOT_ROOM };
  const children = opts.children ?? {};

  const host = app.bind({ provide, services });
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
    getSession: (id: string): SessionInfo => {
      const origin = resolveSessionOrigin(id);
      return {
        id,
        name: id,
        parentId: children[id],
        children: [],
        status: 'active',
        config: {},
        createdAt: 0,
        updatedAt: 0,
        kind: children[id] ? 'task' : 'room',
        originPlatform: origin?.platform,
        audience: children[id] ? undefined : (origin?.audience ?? 'owner'),
      };
    },
  } as unknown as SessionManagerService);
  host.provide(storage, memoryPluginData(files));
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
    tools: registered,
    groups,
    raw,
    call: async (name, args, ctx) => JSON.parse(await raw(name, args, ctx)) as Record<string, unknown>,
    async doctor() {
      const out: CheckResult[] = [];
      for (const spec of checks.values()) out.push(...[await spec.run()].flat());
      return out;
    },
    ledger: () => JSON.parse(files.get(LEDGER_URI) ?? 'null') as PaperLedger,
    async stop() {
      hubs.splice(hubs.indexOf(app), 1);
      await app.stop();
    },
  };
}

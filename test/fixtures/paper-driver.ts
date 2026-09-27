import { vi } from 'vitest';
import type { GatewayService } from '../../packages/api-gateway/src/index.js';
import type { RemoteAgentProvider } from '../../packages/api-remote-agent/src/index.js';
import type {
  SessionConfig,
  SessionInfo,
  SessionManagerService,
} from '../../packages/api-session-manager/src/index.js';
import type { RegisteredTool, ToolCallContext } from '../../packages/api-tools/src/index.js';
import type { Events, Logger } from '../../packages/core/src/index.js';
import { readConfig } from '../../packages/plugin-paper/src/config.js';
import { PaperDriver } from '../../packages/plugin-paper/src/driver.js';
import { LedgerStore, type PaperLedger, type TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import { Isolation } from '../../packages/plugin-paper/src/rooms.js';
import { registerPaperTools } from '../../packages/plugin-paper/src/tools.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { stubBoundTools } from './bound-tools.js';
import { human, LEDGER_URI, memoryStorage, type PaperFiles } from './paper.js';
import { ScriptedRemote } from './paper-remote.js';
import { fixedRef, ref } from './service-ref.js';

// ════════════════════════════════════════════════════════════
// 白纸运行驱动的测试台：照 plugin-paper 的 apply 把账本、隔离、工具与驱动接在一起（不经 App），
// 周边一律替身——远端用 ScriptedRemote，会话管理按会话 id 给房间配置，storage 是 pluginData 与 paper
// 两个根的内存实现（文件表可跨「重启」复用），网关记下出站消息。时钟用 vitest 的假时钟：
// 用例在 beforeEach 里 useFakeTimers（含 Date），驱动的 now 取 Date.now。
// owner 的管理动作（恢复、换新、清空、标为已读）直接调驱动的方法，WebUI 的接线在白纸页。
// 完成通知不接（驱动交给它的回调是空的），通知经真实 App 测，见 paper-notices.test.ts。
// ════════════════════════════════════════════════════════════

export const ROOM_A = 'onebot:10000:group:20001';
export const ROOM_A2 = 'onebot:10000:group:20003';
export const ROOM_B = 'onebot:10000:group:20002';
export const PAPER_A = 'zz-paper-a';
export const PAPER_B = 'zz-paper-b';
export const REMOTE_A = 'zz-remote-a';
export const REMOTE_B = 'zz-remote-b';
export const PAPER_A_ID = `n:${PAPER_A}`;
export const PAPER_A_DIR = `paper:/n-${PAPER_A}`;

export const FAKE_TIMERS = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const,
  now: new Date('2026-09-27T02:00:00Z'),
};

export const MINUTE = 60_000;
export const RECONCILE_MS = 10 * MINUTE;

/** 两块具名白纸各用一个提供者；额度放宽，只看驱动本身 */
export const DRIVER_CONFIG = {
  globalDailyCents: 100_000,
  reconcileMinutes: 10,
  papers: [
    { name: PAPER_A, remoteAgentType: REMOTE_A },
    { name: PAPER_B, remoteAgentType: REMOTE_B },
  ],
};

const room = (paperName: string): SessionConfig => ({
  paperEnabled: true,
  paperName,
  remoteAgentTypes: [REMOTE_A, REMOTE_B],
  remoteAgentRoomDailyCents: 100_000,
});

/** ROOM_A 与 ROOM_A2 共用白纸 a，ROOM_B 用白纸 b */
export const DRIVER_ROOMS: Record<string, SessionConfig> = {
  [ROOM_A]: room(PAPER_A),
  [ROOM_A2]: room(PAPER_A),
  [ROOM_B]: room(PAPER_B),
};

export interface DriverHubOptions {
  config?: Record<string, unknown>;
  rooms?: Record<string, SessionConfig>;
  /** 实例 id → 提供者；缺省只有 REMOTE_A 一个 ScriptedRemote */
  remotes?: Record<string, RemoteAgentProvider>;
  /** 账本与白纸文件；跨「重启」复用同一张表 */
  files?: PaperFiles;
}

export interface DriverHub {
  driver: PaperDriver;
  store: LedgerStore;
  files: PaperFiles;
  outbound: OutgoingMessage[];
  logs: Array<{ level: string; message: string }>;
  /** 落盘的账本 */
  disk(): PaperLedger;
  /** 内存里的一件任务 */
  task(id: string): TaskRecord;
  call(name: string, args: Record<string, unknown>, ctx?: ToolCallContext): Promise<Record<string, unknown>>;
  /** 真人在房间里交一件任务，返回任务 id（受理失败就抛） */
  accept(room?: string, text?: string, userId?: string): Promise<string>;
  /** 停机：中止信号并等收尾落盘 */
  stop(): Promise<void>;
}

const running: DriverHub[] = [];

/** 停掉本文件里起过的全部测试台（afterEach 里调，先于 useRealTimers） */
export async function stopDriverHubs(): Promise<void> {
  for (const hub of running.splice(0)) await hub.stop();
}

function recordingLogger(sink: Array<{ level: string; message: string }>): Logger {
  const at =
    (level: string) =>
    (...args: unknown[]) =>
      void sink.push({ level, message: args.map(String).join(' ') });
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

let taskSeq = 0;

export async function startDriverHub(opts: DriverHubOptions = {}): Promise<DriverHub> {
  const files: PaperFiles = opts.files ?? new Map();
  const logs: Array<{ level: string; message: string }> = [];
  const logger = recordingLogger(logs);
  const cfg = readConfig(opts.config ?? DRIVER_CONFIG, logger);
  const storage = memoryStorage(files);
  const store = new LedgerStore(storage, logger);
  await store.load();
  const controller = new AbortController();
  const remotes = opts.remotes ?? { [REMOTE_A]: new ScriptedRemote() };
  const remote = ref(Object.entries(remotes).map(([contextId, instance]) => ({ instance, contextId, priority: 0 })));
  const rooms = opts.rooms ?? DRIVER_ROOMS;
  const sessionManager = fixedRef({
    resolveConfig: (sessionId: string) => ({ ...(rooms[sessionId] ?? {}) }),
    getSession: (id: string) =>
      ({ id, name: id, children: [], status: 'active', config: {}, createdAt: 0, updatedAt: 0 }) as SessionInfo,
  } as unknown as SessionManagerService);
  const outbound: OutgoingMessage[] = [];
  const gateway = fixedRef<GatewayService>({
    async dispatchOutbound(message: OutgoingMessage) {
      outbound.push(message);
    },
    async ingressMessage() {},
  });
  const now = () => Date.now();
  const isolation = new Isolation(remote, cfg.papers, logger);
  const driver = new PaperDriver({
    remote,
    sessionManager,
    storage,
    ledger: store,
    isolation,
    cfg,
    logger,
    signal: controller.signal,
    now,
    ended: () => {},
  });
  const handlers = new Map<string, RegisteredTool['handler']>();
  registerPaperTools({
    tools: stubBoundTools({ onRegister: tool => void handlers.set(tool.definition.function.name, tool.handler) }),
    sessionManager,
    remote,
    gateway,
    events: { emit: async () => {} } as unknown as Events,
    ledger: store,
    isolation,
    cfg,
    logger,
    signal: controller.signal,
    now,
    kick: paperId => driver.kick(paperId),
    cancel: (taskId, via, gate) => driver.cancel(taskId, via, gate),
  });
  driver.start();

  const call = async (name: string, args: Record<string, unknown>, ctx: ToolCallContext = human('30001', ROOM_A)) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`工具 ${name} 未登记`);
    const out = await handler(args, ctx);
    return JSON.parse(typeof out === 'string' ? out : out.content) as Record<string, unknown>;
  };
  let stopped = false;
  const hub: DriverHub = {
    driver,
    store,
    files,
    outbound,
    logs,
    disk: () => JSON.parse(String(files.get(LEDGER_URI) ?? 'null')) as PaperLedger,
    task: id => {
      const task = store.data.tasks[id];
      if (!task) throw new Error(`账本里没有任务 ${id}`);
      return task;
    },
    call,
    async accept(roomId = ROOM_A, text = `任务原文 ${++taskSeq}`, userId = '30001') {
      const res = await call('paper_task', { text, name: `任务 ${taskSeq}` }, human(userId, roomId));
      if (res.ok !== true) throw new Error(`paper_task 未受理：${String(res.error)}`);
      return String(res.taskId);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const i = running.indexOf(hub);
      if (i >= 0) running.splice(i, 1);
      controller.abort(new DOMException('测试台停机', 'AbortError'));
      await driver.drain();
    },
  };
  running.push(hub);
  return hub;
}

/** 推假时钟直到条件成立（每步 10 毫秒，最多 steps 步）；等不到就抛，带上说明 */
export async function until(pred: () => boolean, label: string, steps = 500): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (pred()) return;
    await vi.advanceTimersByTimeAsync(10);
  }
  if (!pred()) throw new Error(`等不到：${label}`);
}

/** 推假时钟 ms 毫秒（期间的定时器与微任务都跑完） */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

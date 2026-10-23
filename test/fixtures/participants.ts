import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import {
  type Approval,
  type ApprovalAnswer,
  type ApprovalSurface,
  type AttendScope,
  approvals,
} from '../../packages/api-approval/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallRequest, tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, events, optional, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from './app.js';
import { provideHostPaths } from './host-paths.js';
import { registerHubs } from './hubs.js';
import { recordRoom } from './rooms.js';
import { client } from './session-client.js';

// ════════════════════════════════════════════════════════════
// 多人的一轮的审批用例的宿主：真的工具注册表、权限插件、会话管理与会话服务。非 owner 的应答面是测试审批面 chat 上的接入
// （限定群窗口或机器人账号），owner 的 WebUI 是一条在场的会话协议连接。用完由 closeParticipantApps 收拾（放进 afterEach）。
// ════════════════════════════════════════════════════════════

type Identity = { platform: string; userId: string };
type PluginDefinition = Parameters<App['plugin']>[0];

const apps: App[] = [];
const homes: string[] = [];

export async function closeParticipantApps(): Promise<void> {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

const surfacesPlugin = (out: { webui?: ApprovalSurface; chat?: ApprovalSurface }) =>
  definePlugin({
    name: '@test/surfaces',
    uses: { approvals: optional(approvals) },
    apply: ({ approvals }) => {
      out.webui = approvals.use.registerSurface('webui');
      out.chat = approvals.use.registerSurface('chat');
    },
  });

/** 对一张审批的应答：原样带回内容哈希 */
export const answerOf = (approval: Approval, decision: ApprovalAnswer['decision'], note?: string): ApprovalAnswer => ({
  approvalId: approval.id,
  decision,
  contentHash: approval.contentHash,
  note,
});

/** 等这个接入收到第 n 张卡 */
export async function cardOf(attendee: { requested: Approval[] }, n = 1): Promise<Approval> {
  await vi.waitFor(() => expect(attendee.requested).toHaveLength(n));
  return attendee.requested[n - 1];
}

export async function participantsApp({
  config,
  files,
  rooms,
  before = [],
  after = [],
  webui = true,
}: {
  /** 宿主配置文档（owners、确认覆盖、插件配置的全局层等） */
  config: Partial<AalisConfig>;
  files: StorageService;
  /** 经原生入站收录的房间 */
  rooms: readonly string[];
  /** 装在四个插件之前（适配器）与之后（用这些服务的工具插件）的插件 */
  before?: readonly PluginDefinition[];
  after?: readonly PluginDefinition[];
  /** owner 的 WebUI 连接在场 */
  webui?: boolean;
}) {
  const { app } = hostedApp(config);
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  const home = mkdtempSync(join(tmpdir(), 'aalis-participants-'));
  homes.push(home);
  provideHostPaths(app, home);
  const host = app.bind({ provide, events, tools, sessionManager, sessionProtocol, authority });
  host.provide.use(storage, files);
  const out: { webui?: ApprovalSurface; chat?: ApprovalSurface } = {};
  for (const plugin of [...before, toolsPlugin, authorityPlugin, sessionManagerPlugin, sessionServerPlugin, ...after]) {
    await app.plugin(plugin, {});
  }
  await app.plugin(surfacesPlugin(out));
  await app.plugins.idle();
  const { chat, webui: webuiSurface } = out;
  if (!chat || !webuiSurface) throw new Error('审批面没登记上');
  for (const id of rooms) await recordRoom(host.events.use, id);

  let conn: ReturnType<typeof client> | undefined;
  if (webui) {
    conn = client(host.sessionProtocol.use, {
      identity: { platform: 'webui', userId: 'console' },
      surface: webuiSurface,
    });
    await conn.init();
    await conn.call('presence/update', { active: true });
  }

  /** 在审批面 chat 上接入一个客户端，上报在场 */
  const attend = (who: Identity, scope?: AttendScope) => {
    const requested: Approval[] = [];
    const settled: string[] = [];
    const attendance = chat.attend(
      who,
      { requested: approval => requested.push(approval), settled: id => settled.push(id) },
      scope,
    );
    attendance.presence(true);
    const answer = (approval: Approval, decision: ApprovalAnswer['decision'], note?: string) =>
      attendance.respond(answerOf(approval, decision, note));
    return { requested, settled, attendance, answer };
  };

  let seq = 0;
  /** 按 agent 工具循环的填法调一次：带回合与调用 id、入站回合，extra 可以改掉它们 */
  const execute = (
    name: string,
    args: Record<string, unknown>,
    ctx: Pick<ToolCallRequest, 'sessionId' | 'platform' | 'participants'> & Partial<ToolCallRequest>,
  ) => {
    seq++;
    const request: ToolCallRequest = { inbound: {}, turnId: `turn-${seq}`, callId: `call-${seq}`, ...ctx };
    return host.tools.use.execute(name, args, request).then(result => result.content);
  };

  const webuiCards = (): Approval[] => conn?.notifications('approval/requested').map(p => p.approval) ?? [];
  return { app, host, attend, execute, conn, webuiCards };
}

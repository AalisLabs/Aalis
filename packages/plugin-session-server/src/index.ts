import { join } from 'node:path';
import { agent } from '@aalis/api-agent';
import { approvals } from '@aalis/api-approval';
import { authority } from '@aalis/api-authority';
import { checkpoint } from '@aalis/api-checkpoint';
import { hooks } from '@aalis/api-hooks';
import { hostPaths } from '@aalis/api-host-paths';
import { llm } from '@aalis/api-llm';
import { memory } from '@aalis/api-memory';
import { persona } from '@aalis/api-persona';
import { platform } from '@aalis/api-platform';
import { type SessionInfo, sessionManager } from '@aalis/api-session-manager';
import { sessionProtocol } from '@aalis/api-session-protocol';
import { createStorageGateway, storage } from '@aalis/api-storage';
import { todoList } from '@aalis/api-todo-list';
import { tools } from '@aalis/api-tools';
import { type BoundOf, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { approvalHandlers, createApprovals } from './approvals.js';
import { createSessionServer } from './connection.js';
import { createFileHandles } from './files.js';
import type { IsOwner } from './history.js';
import { openSeenStore } from './seen.js';
import { createSessions } from './sessions.js';
import { createTimeline } from './timeline.js';
import { createTurnControl } from './turns.js';

// ════════════════════════════════════════════════════════════
// plugin-session-server — 会话协议的服务端（契约见 @aalis/api-session-protocol）
//
// owner 的客户端经传输层（WebUI 的 WebSocket 等）接到 sessionProtocol.connect。会话本身在 session-manager 里，
// 本插件把它投影成会话列表（分区、分组、状态）、按 session:* 事件推增量，转发会话的增删改与配置，另记「我的」区的已读时间；
// 订阅一个会话时给出快照，之后把 agent、工具与存档的事件拼成条目推送；条目里她发出的文件给本服务签发的下载句柄，
// 传输层经 resolveFile 核验之后下发；回合控制转给 agent、网关、检查点与待办。
// 另提供审批服务（approvals，契约见 @aalis/api-approval）：审批推给在场的审批面，连接上的在场上报与应答经它所在的审批面。
// ════════════════════════════════════════════════════════════

const uses = {
  /** 会话表、配置继承与增删改都经它 */
  sessionManager,
  /** 已读时间落在本插件的插件数据里；签发文件句柄时按存储根的种类挡掉插件状态 */
  storage,
  /** 审批的审计写在家目录的 state/audit 下 */
  paths: hostPaths,
  /** 历史从存档归并 */
  memory,
  /** 回合进出（agent:input:before、agent:turn:after）与定稿校验（agent:reply:before）拼出在途条目；memory:clear 之后重新取快照 */
  hooks,
  /** session:* 事件推列表增量，agent、工具与存档的事件推条目 */
  events,
  lifecycle,
  logger,
  provide,
  /** owner 自己的会话按哪个入口平台选档：看会话 id 归哪个平台适配器 */
  platform: optional(platform),
  /** 下列三项只供会话配置列可选项，缺席即空列表 */
  persona: optional(persona),
  llm: optional(llm),
  tools: optional(tools),
  /** 停止回合 */
  agent: optional(agent),
  /** 回滚 */
  checkpoint: optional(checkpoint),
  /** 计划的快照与清空 */
  todoList: optional(todoList),
  /** 说话人与审批的应答人是不是 owner；缺席时都不是 */
  authority: optional(authority),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-session-server',
  displayName: '会话服务',
  subsystem: 'session',
  provides: [sessionProtocol, approvals],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { events, hooks, lifecycle, logger } = caps;
  // session-manager 是 required 依赖：它换提供者时本插件随之重新激活，这里存下的引用不会过期
  const sm = caps.sessionManager.require();
  const store = createStorageGateway(caps.storage);
  const seen = await openSeenStore(store, logger);
  const files = createFileHandles(() => store.listRoots());
  const isOwner: IsOwner = (platformName, userId) =>
    userId !== undefined && (caps.authority.current?.isOwner(platformName, userId) ?? false);
  const isRoom = (sessionId: string) => {
    const info = sm.getSession(sessionId);
    return info !== undefined && sessions.sectionOf(info) === 'rooms';
  };
  /**
   * 请 agent 重发某会话的用量。房间不填平台，agent 按出生平台算，与群里真实的回合一致；其余会话填连接的入口平台，
   * 与从这条连接发起的回合一致
   */
  const requestUsage = (sessionId: string, platformName: string) =>
    void events.emit('token:request', isRoom(sessionId) ? { sessionId } : { sessionId, platform: platformName });

  const sessions = createSessions({
    sm,
    seen,
    isRunning: id => timeline.isRunning(id),
    hasApproval: id => approval.pendingIn(id),
    changed: id => push([id], []),
    platform: caps.platform,
    persona: caps.persona,
    llm: caps.llm,
    tools: caps.tools,
    logger,
  });
  const timeline = createTimeline({
    memory: caps.memory,
    todoList: caps.todoList,
    isOwner,
    signFile: files.sign,
    requireSession: sessions.requireSession,
    summarize: sessions.summarize,
    isRoom,
    notify: (sessionId, method, params) => server.notifySession(sessionId, method, params),
    requestUsage,
    approvalsOf: sessionId => approval.service.list({ sessionId }),
    signal: lifecycle.signal,
  });
  const approval = createApprovals({
    isOwner,
    events,
    logger,
    auditFile: join(caps.paths.require().state, 'audit', 'approvals.jsonl'),
    changed: card => {
      timeline.approval(card);
      push([card.sessionId], []);
    },
  });
  const control = createTurnControl({
    events,
    agent: caps.agent,
    checkpoint: caps.checkpoint,
    todoList: caps.todoList,
    requireSession: sessions.requireSession,
    requestUsage,
  });
  const server = createSessionServer(
    { ...sessions.handlers, ...timeline.handlers, ...control.handlers, ...approvalHandlers },
    logger,
  );

  /** 把这些会话的最新摘要与删掉的 id 推给 watch 的连接，附最新的分组 */
  function push(ids: string[], removes: string[]): void {
    server.notify(
      'sessions/changed',
      () => ({
        upserts: ids.flatMap(id => {
          const info = sm.getSession(id);
          return info ? [sessions.summarize(info)] : [];
        }),
        removes,
        groups: sessions.groups(),
      }),
      conn => conn.watching,
    );
  }

  const upsert = (session: SessionInfo) => push([session.id], []);
  events.on('session:created', upsert);
  events.on('session:updated', upsert);
  events.on('session:completed', upsert);
  events.on('session:deleted', id => {
    push([], [id]);
    timeline.forget(id);
    seen.forget(id).catch(err => logger.warn(`删除会话后清理已读记录失败 (${id}):`, err));
  });

  // 回合真正开始（agent:input:before）到它的 next 返回之间算运行中；被下游拦下、出错的一轮同样在 finally 里结束
  hooks.middleware('agent:input:before', async (data, next) => {
    const { sessionId } = data.message;
    const turn = timeline.begin(data.turnId, data.message);
    push([sessionId], []);
    try {
      await turn.run(next);
    } finally {
      approval.turnEnded(data.turnId);
      turn.end();
      push([sessionId], []);
    }
  });
  hooks.middleware('agent:turn:after', async (data, next) => {
    timeline.outcome(data.turnId, data.outcome);
    await next();
  });
  hooks.middleware('agent:reply:before', async (_data, next) => {
    timeline.replyCheck();
    await next();
  });
  // 消息历史清掉之后（/clear），订阅的客户端重新取快照。删除会话也经这条钩子，那时会话已不在，删除由列表增量告知
  hooks.middleware('memory:clear', async (data, next) => {
    await next();
    if (data.types && !data.types.includes('context')) return;
    const ids = data.scope === 'all' ? server.subscribedSessions() : [data.sessionId];
    for (const id of ids) if (id !== undefined && sm.getSession(id)) timeline.resync(id);
  });
  events.on('outbound:stream', timeline.stream);
  events.on('tool:execute', timeline.tool);
  events.on('tool:output', timeline.toolOutput);
  events.on('outbound:message', timeline.outbound);
  events.on('inbound:message:archived', ({ sessionId, archivedMessage }) =>
    timeline.archived(sessionId, archivedMessage),
  );
  events.on('assistant:message:archived', ({ sessionId, message }) => timeline.archived(sessionId, message));
  events.on('todo:updated', timeline.plan);
  events.on('token:usage', timeline.usage);
  events.on('session:compressing', ({ sessionId, status }) => timeline.compressing(sessionId, status));
  events.on('history:changed', ({ sessionId }) => timeline.resync(sessionId));

  caps.provide(sessionProtocol, { connect: server.connect, resolveFile: files.resolve }, { label: '会话协议' });
  caps.provide(approvals, approval.service, { label: '审批' });
  // 撤回登记之前结算没结的审批：审批面还接着，结算推得到；之后的请求直接拒绝
  lifecycle.onDrain(() => approval.close(), '结算未结的审批');
  // 对外登记撤回之后断开现有连接：客户端重连时接到新的提供者。停用完成之前把审计写完
  lifecycle.onDispose(() => {
    server.disconnectAll('会话服务已停止');
    return approval.flushed();
  }, '断开会话连接、写完审计');
}

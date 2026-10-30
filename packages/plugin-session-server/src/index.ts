import { join } from 'node:path';
import { agent } from '@aalis/api-agent';
import { approvals } from '@aalis/api-approval';
import { authority } from '@aalis/api-authority';
import { checkpoint } from '@aalis/api-checkpoint';
import { hooks } from '@aalis/api-hooks';
import { hostConfig } from '@aalis/api-host-config';
import { hostPaths } from '@aalis/api-host-paths';
import { i18n } from '@aalis/api-i18n';
import { compression, memory } from '@aalis/api-memory';
import { platform } from '@aalis/api-platform';
import { originChatOf, rootSessionOf, type SessionInfo, sessionManager } from '@aalis/api-session-manager';
import { type Features, sessionProtocol } from '@aalis/api-session-protocol';
import { sessionSettings } from '@aalis/api-session-settings';
import { storage } from '@aalis/api-storage';
import { todoList } from '@aalis/api-todo-list';
import { backgroundTasks, tools } from '@aalis/api-tools';
import { type BoundOf, definePlugin, events, lifecycle, logger, optional, pluginsService, provide } from '@aalis/core';
import { approvalHandlers, createApprovals } from './approvals.js';
import { createBackground } from './background.js';
import { createSessionServer } from './connection.js';
import { type DisplayOf, resolveDisplay } from './display.js';
import { createFileHandles } from './files.js';
import type { IsOwner } from './history.js';
import { openSeenStore } from './seen.js';
import { createSessions } from './sessions.js';
import { t } from './texts.js';
import { createTimeline } from './timeline.js';
import { createTurnControl } from './turns.js';

// ════════════════════════════════════════════════════════════
// plugin-session-server — 会话协议的服务端（契约见 @aalis/api-session-protocol）
//
// owner 的客户端经传输层（WebUI 的 WebSocket 等）接到 sessionProtocol.connect。会话本身在 session-manager 里，
// 本插件把它投影成会话列表（分区、分组、状态）、按 session:* 事件推增量，转发会话的增删改与设置（会话设置的管理面：各插件
// 声明的按会话字段与会话之上的各层），设置或宿主配置文档变了推 session/config/changed，另记「我的」区的已读时间；
// 订阅一个会话时给出快照，之后把 agent、工具与存档的事件拼成条目推送；条目里她发出的文件给本服务签发的下载句柄，
// 传输层经 resolveFile 核验之后下发；回合控制转给 agent、网关、检查点、压缩与待办。后台任务登记投影成列表与增量，
// 取输出、停止与按会话树全部停止转给它与 agent。握手给出功能位（发送、回滚、压缩、会话设置各看对话、检查点、压缩、会话设置服务在不在），
// 服务上下线时推 features/changed；另给出宿主配置里的应用名。帧里的文字对象按全局层的语言渲染（见 connection.ts）。
// 另提供审批服务（approvals，契约见 @aalis/api-approval）：审批推给在场的审批面，连接上的在场上报与应答经它所在的审批面。
// ════════════════════════════════════════════════════════════

const uses = {
  /** 会话表与增删改都经它；审批按根会话的机器人账号认限定了账号的接入；输入里的插话按根会话记下的聊天窗口标出 */
  sessionManager,
  /** 已读时间落在本插件的插件数据里；签发文件句柄时按存储根的种类挡掉插件状态 */
  storage,
  /** 审批的审计写在家目录的 state/audit 下 */
  paths: hostPaths,
  /** 历史从存档归并 */
  memory,
  /**
   * 回合进出（agent:turn:before、agent:turn:after）与定稿校验（agent:reply:before）拼出在途条目，工具结果落库前
   * （agent:tool:after）写上历史要还原的结局；memory:clear 之后重新取快照
   */
  hooks,
  /** session:* 事件推列表增量，agent、工具与存档的事件推条目（含 agent:queue 报的排着的输入） */
  events,
  lifecycle,
  logger,
  provide,
  /** 房间分组的组名：适配器实例的显示名 */
  plugins: pluginsService,
  /** 会话按哪个入口平台选平台档：看根会话的 id 归哪个平台适配器 */
  platform: optional(platform),
  /** 会话设置的管理面：设置的各行、各层、写入与写过的各处，建子会话时写下的那一层；缺席时这些方法与建子会话回 unsupported */
  sessionSettings: optional(sessionSettings),
  /** 停止回合 */
  agent: optional(agent),
  /** 回滚 */
  checkpoint: optional(checkpoint),
  /** 手动压缩，用量条目的压缩线 */
  compression: optional(compression),
  /** 计划的快照与清空 */
  todoList: optional(todoList),
  /** 说话人与审批的应答人是不是 owner；缺席时都不是 */
  authority: optional(authority),
  /** 工具卡与审批卡的展示按工具定义上声明的展示种类取；缺席时都走通用卡 */
  tools: optional(tools),
  /** 后台任务的列表、增量、取输出与停止，摘要里在跑的后台任务数；缺席时这几个方法回 unsupported（watch 与全部停止除外） */
  backgroundTasks: optional(backgroundTasks),
  /** 握手回应里的应用名：宿主配置的 name，每次握手现读；缺席时是 Aalis */
  hostConfig: optional(hostConfig),
  /** 出帧里的文字对象按全局层的语言渲染；缺席时按原文 */
  i18n: optional(i18n),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-session-server',
  displayName: t('displayName'),
  subsystem: 'session',
  provides: [sessionProtocol, approvals],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { events, hooks, lifecycle, logger } = caps;
  // session-manager 是 required 依赖：它换提供者时本插件随之重新激活，这里存下的引用不会过期
  const sm = caps.sessionManager.use;
  const store = caps.storage.use;
  const seen = await openSeenStore(store.own, logger.use);
  const files = createFileHandles(() => store.listRoots());
  const isOwner: IsOwner = (platformName, userId) =>
    userId !== undefined && (caps.authority.present ? caps.authority.use.isOwner(platformName, userId) : false);
  const displaySpec = (tool: string) =>
    caps.tools.present ? caps.tools.use.getAll().find(t => t.name === tool)?.display : undefined;
  const displayOf: DisplayOf = (tool, args, result) => resolveDisplay(displaySpec(tool), args, result);
  /**
   * 请 agent 重发某会话的用量。房间与它的子会话不填平台，agent 按出生平台算，与群里真实的回合一致；其余会话填连接的
   * 入口平台，与从这条连接发起的回合一致
   */
  const requestUsage = (sessionId: string, platformName: string) => {
    const info = sm.getSession(sessionId);
    const pinned = info !== undefined && sessions.sectionOf(info) === 'rooms';
    void events.use.emit('token:request', pinned ? { sessionId } : { sessionId, platform: platformName });
  };

  const sessions = createSessions({
    sm,
    seen,
    isRunning: id => timeline.isRunning(id),
    hasApproval: id => approval.pendingIn(id),
    runningTasks: () => background.runningBySession(),
    changed: id => push([id], []),
    platform: caps.platform,
    settings: caps.sessionSettings,
    plugins: caps.plugins.use,
    logger: logger.use,
  });
  const timeline = createTimeline({
    memory: caps.memory,
    todoList: caps.todoList,
    isOwner,
    signFile: files.sign,
    displayOf,
    requireSession: sessions.requireSession,
    summarize: sessions.summarize,
    isRoom: sessionId => sm.getSession(sessionId)?.kind === 'room',
    multiParty: sessionId => originChatOf(sessionId, caps.sessionManager)?.multiParty === true,
    notify: (sessionId, method, params) => server.notifySession(sessionId, method, params),
    requestUsage,
    compressAt: (sessionId, platform) =>
      caps.compression.present ? caps.compression.use.compressAt(sessionId, platform) : undefined,
    approvalsOf: sessionId => approval.service.list({ sessionId }),
    signal: lifecycle.use.signal,
    logger: logger.use,
  });
  const approval = createApprovals({
    events: events.use,
    logger: logger.use,
    auditFile: join(caps.paths.use.state, 'audit', 'approvals.jsonl'),
    displaySpec,
    // 来源链是根会话以下的各级父会话与它自己。找得到根会话时父会话链完整、不成环，ancestorsOf 的第一级就是它
    rootOf: sessionId => {
      const info = sm.getSession(sessionId);
      const root = rootSessionOf(info, id => sm.getSession(id));
      if (!info || !root) return undefined;
      return {
        id: root.id,
        bot: root.originChat?.selfId,
        ...(root !== info && { chain: [...sessions.ancestorsOf(info).slice(1), info].map(sessions.labelOf) }),
      };
    },
    changed: (card, settlement) => {
      timeline.approval(card, settlement);
      push([card.sessionId], []);
    },
  });
  const control = createTurnControl({
    events: events.use,
    agent: caps.agent,
    checkpoint: caps.checkpoint,
    compression: caps.compression,
    todoList: caps.todoList,
    requireSession: sessions.requireSession,
    requestUsage,
  });
  const background = createBackground({
    tasks: caps.backgroundTasks,
    agent: caps.agent,
    displayOf,
    requireSession: sessions.requireSession,
    descendantsOf: sessions.descendantsOf,
    isRunning: id => timeline.isRunning(id),
    notify: build => server.notify('background/changed', build, conn => conn.watchingBackground),
    sessionChanged: id => push([id], []),
  });
  const currentFeatures = (): Features => ({
    send: caps.agent.present,
    rewind: caps.checkpoint.present,
    compress: caps.compression.present,
    settings: caps.sessionSettings.present,
  });
  const server = createSessionServer(
    { ...sessions.handlers, ...timeline.handlers, ...control.handlers, ...background.handlers, ...approvalHandlers },
    () => ({
      features: currentFeatures(),
      appName: (caps.hostConfig.present ? caps.hostConfig.use.get('name') : undefined) || 'Aalis',
    }),
    logger.use,
    caps.i18n,
    isOwner,
  );
  // 功能位所看的服务上线或下线（通知在变化之后送达）：与上次推的不同才推给每条连接
  let features = currentFeatures();
  const featureServices = new Set([agent.name, checkpoint.name, compression.name, sessionSettings.name]);
  const refreshFeatures = (service: string) => {
    if (!featureServices.has(service)) return;
    const next = currentFeatures();
    if ((Object.keys(next) as Array<keyof Features>).every(key => next[key] === features[key])) return;
    features = next;
    server.notify(
      'features/changed',
      () => ({ features: next }),
      () => true,
    );
  };
  events.use.on('service:changed', refreshFeatures);

  /**
   * 把这些会话连同各级父会话的最新摘要与删掉的 id 推给 watch 的连接，附最新的分组：父会话的摘要里有按子树算的字段
   * （在跑的后台工作数、token 合计），子会话的回合与任务进出、token 记账都会改它
   */
  function push(ids: string[], removes: string[]): void {
    server.notify(
      'sessions/changed',
      () => {
        const changed = new Map<string, SessionInfo>();
        for (const id of ids) {
          const info = sm.getSession(id);
          for (const each of info ? [info, ...sessions.ancestorsOf(info)] : []) changed.set(each.id, each);
        }
        const tasks = background.runningBySession();
        return {
          upserts: [...changed.values()].map(info => sessions.summarize(info, tasks)),
          removes,
          groups: sessions.groups(),
        };
      },
      conn => conn.watching,
    );
  }

  const upsert = (session: SessionInfo) => push([session.id], []);
  events.use.on('session:created', upsert);
  events.use.on('session:updated', upsert);
  events.use.on('session:completed', upsert);
  events.use.on('session:deleted', id => {
    push([], [id]);
    timeline.forget(id);
    seen.forget(id).catch(err => logger.use.warn(`删除会话后清理已读记录失败 (${id}):`, err));
  });
  // 设置变了（字段登记增减、场所或会话这一层被改写、会话增删）或宿主配置文档变了（插件配置、平台档、平台类型档等）：每条连接各推
  // 一次，客户端重取打开着的设置
  const configChanged = () =>
    server.notify(
      'session/config/changed',
      () => ({}),
      () => true,
    );
  events.use.on('session-settings:changed', configChanged);
  events.use.on('host-config:changed', configChanged);

  // 回合真正开始（agent:turn:before）到它的 next 返回之间算运行中；被下游拦下、出错的一轮同样在 finally 里结束
  hooks.use.middleware('agent:turn:before', async (data, next) => {
    const { sessionId } = data;
    const turn = timeline.begin(data.turnId, sessionId, data.inputs[0].message.source);
    push([sessionId], []);
    try {
      await turn.run(next);
    } finally {
      approval.turnEnded(data.turnId);
      turn.end();
      push([sessionId], []);
    }
  });
  hooks.use.middleware('agent:turn:after', async (data, next) => {
    timeline.outcome(data.turnId, data.outcome);
    await next();
  });
  // 工具返回时回合的中止信号已触发：停止时这次调用还没结束。转到后台的调用此时已在登记表里
  hooks.use.middleware('agent:tool:after', async (data, next) => {
    const { sessionId, turnId, callId, signal } = data.toolCallContext;
    if (turnId && callId) {
      const taskId = background.taskOf(sessionId, turnId, callId);
      Object.assign(
        data.metadata,
        await timeline.toolMetadata(turnId, callId, signal?.aborted === true, data.result, taskId),
      );
    }
    await next();
  });
  hooks.use.middleware('agent:reply:before', async (_data, next) => {
    timeline.replyCheck();
    await next();
  });
  // 消息历史清掉之后（/clear），订阅的客户端重新取快照。删除会话也经这条钩子，那时会话已不在，删除由列表增量告知
  hooks.use.middleware('memory:clear', async (data, next) => {
    await next();
    if (data.types && !data.types.includes('context')) return;
    const ids = data.scope === 'all' ? server.subscribedSessions() : [data.sessionId];
    for (const id of ids) if (id !== undefined && sm.getSession(id)) timeline.resync(id);
  });
  events.use.on('outbound:stream', timeline.stream);
  events.use.on('tool:execute', timeline.tool);
  events.use.on('tool:output', timeline.toolOutput);
  events.use.on('background:changed', background.changed);
  events.use.on('outbound:message', timeline.outbound);
  events.use.on('inbound:message:archived', ({ sessionId, archivedMessage }) =>
    timeline.archived(sessionId, archivedMessage),
  );
  events.use.on('assistant:message:archived', ({ sessionId, message }) => timeline.archived(sessionId, message));
  events.use.on('todo:updated', timeline.plan);
  events.use.on('agent:queue', ({ sessionId, waiting }) => timeline.queue(sessionId, waiting));
  events.use.on('token:usage', timeline.usage);
  events.use.on('session:compressing', ({ sessionId, status }) => timeline.compressing(sessionId, status));
  events.use.on('history:changed', ({ sessionId }) => timeline.resync(sessionId));

  caps.provide.use(
    sessionProtocol,
    { connect: server.connect, resolveFile: files.resolve },
    { label: t('protocolLabel') },
  );
  caps.provide.use(approvals, approval.service, { label: t('approvalsLabel') });
  // 撤回登记之前结算没结的审批：审批面还接着，结算推得到；之后的请求直接拒绝
  lifecycle.use.onDrain(() => approval.close(), '结算未结的审批');
  // 对外登记撤回之后断开现有连接：客户端重连时接到新的提供者。停用完成之前把审计写完
  lifecycle.use.onDispose(() => {
    background.dispose();
    server.disconnectAll('会话服务已停止');
    return approval.flushed();
  }, '断开会话连接、写完审计');
}

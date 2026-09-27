// ============================================================
// @aalis/plugin-paper — 白纸枢纽
//
// 试点群里真人提需求，她调 paper_task 把任务交给远端代理（remote-agent 提供者，按白纸配置里写的实例 id
// 精确取）；宿主先在群里回显原文，受理后排队、记账。房间用哪块白纸、每天能花多少由会话配置决定
// （paperEnabled、paperName、remoteAgentTypes、remoteAgent*DailyCents），白纸本身的属性与全局上限在
// 本插件配置里。运行驱动（driver.ts）按白纸排队开轮、跟踪到终态、取回成品放进白纸根、按轮记账，并定期对账。
// 任务到终态后以宿主通知回到发起房间（notices.ts），她用 paper_send 把成品发回；没发回的在之后的对话里
// 一直有待交付提示。owner 在 WebUI 白纸页（webui.ts）看白纸、任务、成品、账本与告警，并做换新、归档、清空、
// 恢复、取消与告警已读；诊断项（doctor.ts）报让远端任务开不了的配置与账本问题。
//
// apply 只读本地账本、登记工具、钩子、页面与诊断项，不连网；接回进行中的任务在 apply 返回后进行，
// 完成通知在 app:started 之后才开始注入。
// ============================================================

import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { doctor } from '@aalis/api-doctor';
import { gateway } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { remoteAgent } from '@aalis/api-remote-agent';
import { sessionManager } from '@aalis/api-session-manager';
import { createStorageGateway, storage } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import { webuiServer } from '@aalis/api-webui';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional } from '@aalis/core';
import { configSchema, readConfig } from './config.js';
import { registerPaperDoctor } from './doctor.js';
import { PaperDriver } from './driver.js';
import { LedgerStore } from './ledger.js';
import { PaperNotices, registerPendingHint } from './notices.js';
import { Isolation } from './rooms.js';
import { registerPaperTools } from './tools.js';
import { registerPaperPage } from './webui.js';

const uses = {
  tools,
  sessionManager,
  storage,
  remoteAgent: optional(remoteAgent),
  gateway: optional(gateway),
  webui: optional(webuiServer),
  doctor: optional(doctor),
  events,
  hooks,
  lifecycle,
  logger,
  config,
};

export default definePlugin({
  name: '@aalis/plugin-paper',
  displayName: '白纸',
  subsystem: 'agent',
  configSchema,
  uses,
  apply: run,
});

async function run(caps: BoundOf<typeof uses>): Promise<void> {
  const { logger, lifecycle } = caps;
  const cfg = readConfig(caps.config, logger);
  const storage = createStorageGateway(caps.storage);
  const ledger = new LedgerStore(storage, logger);
  await ledger.load();

  const now = Date.now;
  const notices = new PaperNotices({ ledger, events: caps.events, logger, now });
  const driver = new PaperDriver({
    remote: caps.remoteAgent,
    sessionManager: caps.sessionManager,
    storage,
    ledger,
    cfg,
    logger,
    signal: lifecycle.signal,
    now,
    ended: () => notices.flush(),
  });
  lifecycle.onDrain(async () => {
    await notices.close();
    await driver.drain();
  }, '白纸停止通知与出队并落盘账本');
  const isolation = new Isolation(caps.remoteAgent, cfg.papers);
  registerPaperTools({
    tools: caps.tools,
    sessionManager: caps.sessionManager,
    remote: caps.remoteAgent,
    gateway: caps.gateway,
    events: caps.events,
    ledger,
    isolation,
    cfg,
    logger,
    signal: lifecycle.signal,
    now,
    kick: paperId => driver.kick(paperId),
    cancel: (taskId, via, gate) => driver.cancel(taskId, via, gate),
  });
  registerPendingHint({ hooks: caps.hooks, ledger, cfg, now });
  registerPaperPage({
    webui: caps.webui,
    driver,
    ledger,
    storage,
    remote: caps.remoteAgent,
    sessionManager: caps.sessionManager,
    cfg,
    signal: lifecycle.signal,
    now,
  });
  registerPaperDoctor({
    doctor: caps.doctor,
    sessionManager: caps.sessionManager,
    remote: caps.remoteAgent,
    ledger,
    isolation,
    cfg,
    signal: lifecycle.signal,
  });
  driver.start();
  caps.events.on('app:started', () => notices.open());
}

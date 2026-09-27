// ============================================================
// @aalis/plugin-paper — 白纸枢纽
//
// 试点群里真人提需求，她调 paper_task 把任务交给远端代理（remote-agent 提供者，按白纸配置里写的实例 id
// 精确取）；宿主先在群里回显原文，受理后排队、记账。房间用哪块白纸、每天能花多少由会话配置决定
// （paperEnabled、paperName、remoteAgentTypes、remoteAgent*DailyCents），白纸本身的属性与全局上限在
// 本插件配置里。
//
// apply 只读本地账本、登记工具与诊断项，不连网。
// ============================================================

import { doctor } from '@aalis/api-doctor';
import { gateway } from '@aalis/api-gateway';
import { remoteAgent } from '@aalis/api-remote-agent';
import { sessionManager } from '@aalis/api-session-manager';
import { createStorageGateway, storage } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional } from '@aalis/core';
import { configSchema, readConfig } from './config.js';
import { registerPaperDoctor } from './doctor.js';
import { LedgerStore } from './ledger.js';
import { Isolation } from './rooms.js';
import { registerPaperTools } from './tools.js';

const uses = {
  tools,
  sessionManager,
  storage,
  remoteAgent: optional(remoteAgent),
  gateway: optional(gateway),
  doctor: optional(doctor),
  events,
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
  const ledger = new LedgerStore(createStorageGateway(caps.storage), logger);
  await ledger.load();
  lifecycle.onDrain(() => ledger.flush(), '白纸账本落盘');

  const now = Date.now;
  const isolation = new Isolation(caps.remoteAgent, cfg.papers, now);
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
  });
  registerPaperDoctor({ doctor: caps.doctor, ledger, isolation, signal: lifecycle.signal });
}

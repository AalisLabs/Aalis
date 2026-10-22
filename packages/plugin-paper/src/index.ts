// ============================================================
// @aalis/plugin-paper — 白纸枢纽
//
// 试点群里真人提需求，她调 paper_task 把任务交给远端代理（remote-agent 提供者，按白纸配置里写的实例 id
// 精确取）；受理后排队、记账，前台自然确认，不额外回显原文。房间用哪块白纸、每天能花多少由本插件的按会话字段决定
// （paperEnabled、paperName、remoteAgentTypes、remoteAgent*DailyCents，按场所设，见 config.ts 与 rooms.ts），白纸本身的
// 属性与全局上限是普通的插件配置。运行驱动（driver.ts）按白纸排队开轮、跟踪到终态、取回成品放进白纸根、按轮记账，并定期对账。
// 显式 publish:false 的任务到终态后以宿主通知回到发起房间（notices.ts），她用 paper_send 把成品发回；没发回的在之后的对话里
// 一直有待交付提示。owner 在 WebUI 白纸页（webui.ts）看白纸、任务、成品、账本与告警，并做换新、归档、清空、
// 恢复、取消与告警已读，开了白纸的群在会话面板里看本群的；诊断项（doctor.ts）报让远端任务开不了的配置与账本问题。
// 上线任务由 publication.ts 从持久意图推进，发布服务在作品站核验后通知，无需前台串联工具。
//
// apply 只读本地账本、登记工具、钩子、页面与诊断项，不连网；接回进行中的任务在 apply 返回后进行，
// 完成通知在 app:started 之后才开始注入。
// ============================================================

import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { doctor } from '@aalis/api-doctor';
import { gateway } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { ownHostConfig } from '@aalis/api-host-config';
import { publish } from '@aalis/api-publish';
import { remoteAgent } from '@aalis/api-remote-agent';
import { sessionManager } from '@aalis/api-session-manager';
import { sessionFields } from '@aalis/api-session-settings';
import { storage } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import { webuiServer } from '@aalis/api-webui';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional } from '@aalis/core';
import { parseConfig } from '@aalis/schema-config';
import { configSchema, paperAuditSchema, readConfig } from './config.js';
import { deliverArtifacts } from './deliver.js';
import { registerPaperDoctor } from './doctor.js';
import { PaperDriver } from './driver.js';
import { LedgerStore } from './ledger.js';
import { PaperNotices, registerPendingHint } from './notices.js';
import { PaperPublication } from './publication.js';
import { Isolation } from './rooms.js';
import { TaskJournal } from './task-journal.js';
import { registerPaperTools } from './tools.js';
import { registerPaperPage } from './webui.js';
import { registerWorksTools } from './works.js';

const uses = {
  tools,
  sessionManager,
  storage,
  remoteAgent: optional(remoteAgent),
  publish: optional(publish),
  gateway: optional(gateway),
  webui: optional(webuiServer),
  doctor: optional(doctor),
  /** 按房间读本插件的六个按会话字段；缺席时取插件配置里的值 */
  sessionFields: optional(sessionFields),
  /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
  document: optional(ownHostConfig),
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
  const cfg = readConfig(
    parseConfig(configSchema, caps.config.use, logger.use),
    logger.use,
    // 只为认出写错的具名白纸；不传日志器，告警已由上面的正式解析报过
    parseConfig(paperAuditSchema, caps.config.use).papers,
  );
  const fields = caps.sessionFields.use.fields(configSchema, caps);
  const storage = caps.storage.use;
  const ledger = new LedgerStore(storage.own, logger.use);
  await ledger.load();

  const now = Date.now;
  const journal = new TaskJournal(storage.own, logger.use, now);
  const notices = new PaperNotices({
    ledger,
    events: caps.events.use,
    logger: logger.use,
    now,
    cfg,
    deliver: (task, artifacts) =>
      deliverArtifacts(
        { ledger, gateway: caps.gateway, events: caps.events.use, logger: logger.use, signal: lifecycle.use.signal },
        task,
        artifacts,
        lifecycle.use.signal,
      ),
  });
  const publications = new PaperPublication({
    journal,
    ledger,
    cfg,
    storage,
    publish: caps.publish,
    producer: lifecycle.use.id,
    signal: lifecycle.use.signal,
    logger: logger.use,
    now,
    onChange: () => notices.flush(),
  });
  const isolation = new Isolation(caps.remoteAgent, cfg.papers, logger.use);
  const driver = new PaperDriver({
    journal,
    remote: caps.remoteAgent,
    sessionManager: caps.sessionManager,
    fields,
    storage,
    ledger,
    isolation,
    cfg,
    logger: logger.use,
    signal: lifecycle.use.signal,
    now,
    ended: () => {
      publications.kick();
      notices.flush();
    },
  });
  lifecycle.use.onDrain(async () => {
    await notices.close();
    await driver.drain();
    await publications.close();
    await journal.flush();
  }, '白纸停止通知、出队与发布并落盘账本');
  registerPaperTools({
    journal,
    tools: caps.tools.use,
    sessionManager: caps.sessionManager,
    fields,
    remote: caps.remoteAgent,
    gateway: caps.gateway,
    events: caps.events.use,
    ledger,
    isolation,
    cfg,
    logger: logger.use,
    signal: lifecycle.use.signal,
    now,
    kick: paperId => driver.kick(paperId),
    cancel: (taskId, via, gate) => driver.cancel(taskId, via, gate),
    directSending: task => notices.directSending(task),
  });
  registerWorksTools({
    producer: lifecycle.use.id,
    onPublicationChange: () => publications.kick(),
    signal: lifecycle.use.signal,
    tools: caps.tools.use,
    sessionManager: caps.sessionManager,
    fields,
    publish: caps.publish,
    storage,
    ledger,
    cfg,
  });
  registerPendingHint({ hooks: caps.hooks.use, ledger, cfg, now, directSending: task => notices.directSending(task) });
  registerPaperPage({
    webui: caps.webui.use,
    driver,
    ledger,
    storage,
    remote: caps.remoteAgent,
    publish: caps.publish,
    sessionManager: caps.sessionManager,
    fields,
    cfg,
    signal: lifecycle.use.signal,
    now,
  });
  registerPaperDoctor({
    doctor: caps.doctor.use,
    sessionManager: caps.sessionManager,
    fields,
    remote: caps.remoteAgent,
    ledger,
    isolation,
    cfg,
    signal: lifecycle.use.signal,
    listingFailures: () => driver.listingFailures(),
  });
  driver.start();
  caps.events.use.on('app:started', () => {
    publications.open();
    notices.open();
  });
}

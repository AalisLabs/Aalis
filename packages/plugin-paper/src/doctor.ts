// ============================================================
// 诊断项 paper.config：让远端任务开不了、或让长期代理的可见范围超出预期的配置与账本问题
//
// - error：账本读取失败；同一远端账号下多于一块具名白纸；有停开的白纸；有未读的账本外代理告警。
// - warn：取不到提供者的账号标识（写明原因，按冲突处理）；全局层、平台档或平台类型档写了 remoteAgentTypes（全部房间、这个
//   平台或这个平台这种类型的全部房间都继承）；具名白纸引用的提供者不在场；一块具名白纸被多个房间共用；globalDailyCents 为 0；对账里列代理或轮次连续失败到 3 次（写类别与次数，
//   不写提供者报错的原文）；有任务认领失败后仍在开轮中（与放弃跟踪同一判据：账本里有它的 claim-failed 告警，不论
//   是否已读；报出时 owner 就能在任务表放弃跟踪）。
// - 出网方式取自 owner 配置（提供者核实不了）时在说明里标「未核实」，不影响级别。
// ============================================================

import type { BoundDoctor, CheckLevel, CheckResult } from '@aalis/api-doctor';
import { type RemoteAgentProvider, resolveRemoteAgent } from '@aalis/api-remote-agent';
import type { SessionManagerService } from '@aalis/api-session-manager';
import type { ServiceSelection } from '@aalis/core';
import { type TextRef, textClauses, textOf } from '@aalis/schema-i18n';
import { egressName, type PaperConfig } from './config.js';
import type { LedgerStore } from './ledger.js';
import { type Isolation, layerName, layersWith, type PaperFields, paperLabel, sharingRooms } from './rooms.js';
import { t } from './texts.js';

const CHECK_ID = 'paper.config';

export function registerPaperDoctor(deps: {
  doctor: BoundDoctor;
  sessionManager: ServiceSelection<SessionManagerService>;
  fields: PaperFields;
  remote: ServiceSelection<RemoteAgentProvider>;
  ledger: LedgerStore;
  isolation: Isolation;
  cfg: PaperConfig;
  signal: AbortSignal;
  /** 对账里列表连续失败到 3 次的提供者实例（见 PaperDriver.listingFailures） */
  listingFailures: () => Array<{ type: string; count: number; categories: TextRef[] }>;
}): void {
  deps.doctor.registerCheck({
    id: CHECK_ID,
    category: 'config',
    async run(): Promise<CheckResult> {
      const { ledger, cfg } = deps;
      const sm = deps.sessionManager.use;
      const errors: TextRef[] = [];
      const warnings: TextRef[] = [];
      const notes: TextRef[] = [];

      if (ledger.failure) errors.push(t('doctorLedgerDown', { failure: ledger.failure }));
      const { collisions, unknown } = await deps.isolation.report(deps.signal);
      for (const papers of collisions) errors.push(t('doctorCollision', { papers }));
      for (const [paperId, paper] of Object.entries(ledger.data.papers)) {
        if (paper.halted) errors.push(t('doctorHalted', { paper: paperLabel(paperId), detail: paper.halted.detail }));
      }
      for (const alert of ledger.data.alerts) {
        if (alert.kind !== 'unknown-agent' || alert.acknowledged) continue;
        errors.push(t('doctorUnknownAgent', { type: String(alert.providerType), agent: String(alert.subject) }));
      }

      for (const { type, papers, detail } of unknown)
        warnings.push(t('doctorAccountUnknown', { type, papers, detail }));
      for (const { layer, value } of layersWith(deps.fields, 'remoteAgentTypes')) {
        if (value.length === 0) continue;
        warnings.push(t('doctorTypesInherited', { types: value, layer: layerName(layer) }));
      }
      for (const [name, spec] of cfg.papers) {
        const type = spec.remoteAgentType;
        if (type && !resolveRemoteAgent(deps.remote, type)) warnings.push(t('doctorRemoteAbsent', { name, type }));
        const { labels, shared } = sharingRooms(sm, deps.fields, ledger.data, `n:${name}`);
        if (shared) warnings.push(t('doctorShared', { name, rooms: labels }));
      }
      for (const [name, problem] of cfg.brokenPapers) errors.push(t('doctorBroken', { name, problem }));
      if (cfg.globalDailyCents === 0) warnings.push(t('doctorGlobalZero'));
      if (cfg.globalDailyCents === undefined) notes.push(t('doctorUnlimited'));
      for (const task of Object.values(ledger.data.tasks)) {
        if (task.state !== 'starting') continue;
        if (!ledger.data.alerts.some(a => a.kind === 'claim-failed' && a.subject === task.id)) continue;
        warnings.push(t('doctorClaimFailed', { id: task.id, room: task.room }));
      }
      for (const { type, count, categories } of deps.listingFailures()) {
        warnings.push(t('doctorListing', { type, count, categories }));
      }

      const types = new Set([cfg.defaults.remoteAgentType, ...[...cfg.papers.values()].map(s => s.remoteAgentType)]);
      for (const type of types) {
        const provider = type ? resolveRemoteAgent(deps.remote, type) : undefined;
        if (!provider) continue;
        try {
          const egress = await provider.use.egress(deps.signal);
          if (egress.source === 'owner-config') {
            notes.push(t('doctorEgressUnverified', { type, mode: egressName(egress.mode) }));
          }
        } catch (err) {
          warnings.push(t('doctorEgressFailed', { type, error: textOf(err) }));
        }
      }

      const level: CheckLevel = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'ok';
      return {
        id: CHECK_ID,
        category: 'config',
        level,
        message: textClauses(level === 'ok' ? [t('doctorOk'), ...notes] : [...errors, ...warnings, ...notes]),
      };
    },
  });
}

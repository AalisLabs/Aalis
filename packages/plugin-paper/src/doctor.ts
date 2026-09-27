// ============================================================
// 诊断项 paper.config：让远端任务开不了、或让长期代理的可见范围超出预期的配置与账本问题
//
// - error：账本读取失败；同一远端账号下多于一块具名白纸；有停开的白纸；有未读的账本外代理告警。
// - warn：取不到提供者的账号标识（写明原因，按冲突处理）；平台档写了 remoteAgentTypes（这个平台所有房间都继承）；
//   具名白纸引用的提供者不在场；一块具名白纸被多个房间共用；globalDailyCents 为 0。
// - 出网方式取自 owner 配置（提供者核实不了）时在说明里标「未核实」，不影响级别。
// ============================================================

import type { BoundDoctor, CheckLevel, CheckResult } from '@aalis/api-doctor';
import { type RemoteAgentProvider, resolveRemoteAgent } from '@aalis/api-remote-agent';
import type { SessionManagerService } from '@aalis/api-session-manager';
import type { ServiceRef } from '@aalis/core';
import type { PaperConfig } from './config.js';
import type { LedgerStore } from './ledger.js';
import { type Isolation, paperLabel, sharingRooms } from './rooms.js';
import { describe } from './util.js';

const CHECK_ID = 'paper.config';

export function registerPaperDoctor(deps: {
  doctor: BoundDoctor;
  sessionManager: ServiceRef<SessionManagerService>;
  remote: ServiceRef<RemoteAgentProvider>;
  ledger: LedgerStore;
  isolation: Isolation;
  cfg: PaperConfig;
  signal: AbortSignal;
}): void {
  deps.doctor.registerCheck({
    id: CHECK_ID,
    category: 'config',
    async run(): Promise<CheckResult> {
      const { ledger, cfg } = deps;
      const sm = deps.sessionManager.require();
      const errors: string[] = [];
      const warnings: string[] = [];
      const notes: string[] = [];

      if (ledger.failure) errors.push(`${ledger.failure}，远端任务一律不开`);
      const { collisions, unknown } = await deps.isolation.report(deps.signal);
      for (const papers of collisions) {
        errors.push(`白纸 ${papers.join('、')} 用的提供者在同一远端账号下（同账号的代理能互读对话），这几块都不开`);
      }
      for (const [paperId, paper] of Object.entries(ledger.data.papers)) {
        if (paper.halted)
          errors.push(`白纸 ${paperLabel(paperId)} 已停开（${paper.halted.detail}），等 owner 在 WebUI 恢复`);
      }
      for (const alert of ledger.data.alerts) {
        if (alert.kind !== 'unknown-agent' || alert.acknowledged) continue;
        errors.push(
          `远端代理「${alert.providerType}」的账号下有账本外的代理 ${alert.subject}，用它的白纸停开，` +
            '等 owner 在 WebUI 核实并标为已读',
        );
      }

      for (const { type, papers, detail } of unknown) {
        warnings.push(
          `取不到提供者「${type}」的远端账号标识（白纸 ${papers.join('、')}；原因：${detail}），` +
            '按冲突处理：引用同类提供者的具名白纸都不开',
        );
      }
      for (const [platform, profile] of Object.entries(sm.getPlatformProfiles())) {
        const types = Array.isArray(profile.remoteAgentTypes) ? profile.remoteAgentTypes : [];
        if (types.length === 0) continue;
        warnings.push(
          `平台档 ${platform} 写了 remoteAgentTypes（${types.join('、')}），这个平台所有开了白纸的房间都会继承；` +
            '只写在房间自己的会话配置里即可',
        );
      }
      for (const [name, spec] of cfg.papers) {
        const type = spec.remoteAgentType;
        if (type && !resolveRemoteAgent(deps.remote, type))
          warnings.push(`白纸 ${name} 引用的远端代理「${type}」不在场`);
        const { labels, shared } = sharingRooms(sm, ledger.data, `n:${name}`);
        if (shared) {
          warnings.push(
            `白纸 ${name} 被多个房间共用（${labels.join('、')}）：长期代理的对话与工作区对所有这些房间可见`,
          );
        }
      }
      if (cfg.globalDailyCents <= 0) warnings.push('globalDailyCents 为 0，远端任务不会开');

      const types = new Set([cfg.defaults.remoteAgentType, ...[...cfg.papers.values()].map(s => s.remoteAgentType)]);
      for (const type of types) {
        const provider = type ? resolveRemoteAgent(deps.remote, type) : undefined;
        if (!provider) continue;
        try {
          const egress = await provider.instance.egress(deps.signal);
          if (egress.source === 'owner-config')
            notes.push(`远端代理「${type}」的出网方式（${egress.mode}）取自 owner 配置，未核实`);
        } catch (err) {
          warnings.push(`取不到远端代理「${type}」的出网方式，用它的白纸不开：${describe(err)}`);
        }
      }

      const level: CheckLevel = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'ok';
      return {
        id: CHECK_ID,
        category: 'config',
        level,
        message: (level === 'ok' ? ['白纸配置与账本正常', ...notes] : [...errors, ...warnings, ...notes]).join('；'),
      };
    },
  });
}

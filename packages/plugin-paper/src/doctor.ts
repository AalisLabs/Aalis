// ============================================================
// 诊断项 paper.config：让远端任务开不了的配置与账本问题
// ============================================================

import type { BoundDoctor, CheckLevel, CheckResult } from '@aalis/api-doctor';
import type { LedgerStore } from './ledger.js';
import type { Isolation } from './rooms.js';

const CHECK_ID = 'paper.config';

export function registerPaperDoctor(deps: {
  doctor: BoundDoctor;
  ledger: LedgerStore;
  isolation: Isolation;
  signal: AbortSignal;
}): void {
  deps.doctor.registerCheck({
    id: CHECK_ID,
    category: 'config',
    async run(): Promise<CheckResult> {
      const errors: string[] = [];
      const warnings: string[] = [];
      if (deps.ledger.failure) errors.push(`${deps.ledger.failure}，远端任务一律不开`);
      const { collisions, unknown } = await deps.isolation.report(deps.signal);
      for (const papers of collisions) {
        errors.push(`白纸 ${papers.join('、')} 用的提供者在同一远端账号下（同账号的代理能互读对话），这几块都不开`);
      }
      for (const { type, papers } of unknown) {
        warnings.push(
          `取不到提供者「${type}」的远端账号标识（白纸 ${papers.join('、')}），按冲突处理：引用同类提供者的具名白纸都不开`,
        );
      }
      const level: CheckLevel = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'ok';
      return {
        id: CHECK_ID,
        category: 'config',
        level,
        message: level === 'ok' ? '白纸配置与账本正常' : [...errors, ...warnings].join('；'),
      };
    },
  });
}

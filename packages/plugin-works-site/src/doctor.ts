import type { BoundDoctor, CheckResult } from '@aalis/api-doctor';
import type { WorksSiteConfig } from './config.js';
import type { WorksDeployer } from './deploy.js';
import type { WorksStore } from './state.js';
import { t } from './texts.js';

export function registerWorksDoctor(deps: {
  doctor: BoundDoctor;
  config: WorksSiteConfig;
  deployer: WorksDeployer;
  store: WorksStore;
  now?: () => number;
}): void {
  const id =
    deps.config.targetId && deps.config.targetId !== 'works'
      ? `works-site.config.${deps.config.targetId}`
      : 'works-site.config';
  deps.doctor.registerCheck({
    id,
    category: 'config',
    run(): CheckResult {
      const now = deps.now?.() ?? Date.now();
      if (deps.store.failure) return { id, category: 'config', level: 'error', message: deps.store.failure };
      const health = deps.deployer.health();
      if (!health.ok) return { id, category: 'config', level: 'error', message: health.reason };
      if (deps.deployer.onlineFailOpen !== undefined && deps.deployer.onlineFailOpen !== deps.config.failOpen) {
        return { id, category: 'config', level: 'error', message: t('onlineFailOpenMismatch') };
      }
      if (deps.deployer.tokenExpiresOn !== undefined) {
        if (deps.deployer.tokenExpiresOn <= now)
          return { id, category: 'config', level: 'error', message: t('tokenExpired') };
        if (deps.deployer.tokenExpiresOn - now < 14 * 24 * 60 * 60_000) {
          return { id, category: 'config', level: 'warn', message: t('tokenExpiring') };
        }
      }
      const state = deps.store.data;
      const unread = state?.alerts.filter(alert => !alert.acknowledged) ?? [];
      return {
        id,
        category: 'config',
        level: unread.length ? 'warn' : 'ok',
        message: unread.length ? t('unreadAlerts', { count: unread.length }) : t('configHealthy'),
      };
    },
  });
}

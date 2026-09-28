import type { BoundDoctor, CheckResult } from '@aalis/api-doctor';
import type { WorksSiteConfig } from './config.js';
import type { WorksDeployer } from './deploy.js';
import type { WorksStore } from './state.js';

export function registerWorksDoctor(deps: {
  doctor: BoundDoctor;
  config: WorksSiteConfig;
  deployer: WorksDeployer;
  store: WorksStore;
  now?: () => number;
}): void {
  deps.doctor.registerCheck({
    id: 'works-site.config',
    category: 'config',
    run(): CheckResult {
      const now = deps.now?.() ?? Date.now();
      if (deps.store.failure)
        return { id: 'works-site.config', category: 'config', level: 'error', message: deps.store.failure };
      const health = deps.deployer.health();
      if (!health.ok) return { id: 'works-site.config', category: 'config', level: 'error', message: health.reason };
      if (deps.deployer.onlineFailOpen !== undefined && deps.deployer.onlineFailOpen !== deps.config.failOpen) {
        return { id: 'works-site.config', category: 'config', level: 'error', message: '线上 fail_open 与配置不符' };
      }
      if (deps.deployer.tokenExpiresOn !== undefined) {
        if (deps.deployer.tokenExpiresOn <= now)
          return { id: 'works-site.config', category: 'config', level: 'error', message: 'Cloudflare token 已过期' };
        if (deps.deployer.tokenExpiresOn - now < 14 * 24 * 60 * 60_000) {
          return {
            id: 'works-site.config',
            category: 'config',
            level: 'warn',
            message: 'Cloudflare token 将在 14 天内过期',
          };
        }
      }
      const state = deps.store.data;
      const unread = state?.alerts.filter(alert => !alert.acknowledged) ?? [];
      return {
        id: 'works-site.config',
        category: 'config',
        level: unread.length ? 'warn' : 'ok',
        message: unread.length ? `作品站有 ${unread.length} 条未读告警` : '作品站配置与已核对状态正常',
      };
    },
  });
}

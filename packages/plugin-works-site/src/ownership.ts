import type { AppService } from '@aalis/core';
import type { WorksSiteConfig } from './config.js';

interface Claims {
  targets: Map<string, symbol>;
  projects: Map<string, symbol>;
}

const byApp = new WeakMap<AppService, Claims>();

/** One live deployer per target and per Pages project inside an App. */
export function claimWorksTarget(app: AppService, config: WorksSiteConfig): () => void {
  let claims = byApp.get(app);
  if (!claims) {
    claims = { targets: new Map(), projects: new Map() };
    byApp.set(app, claims);
  }
  const project = JSON.stringify([config.accountId, config.projectName]);
  if (claims.targets.has(config.targetId) || claims.projects.has(project)) {
    throw new Error('作品站目标或项目已由本宿主的另一实例管理');
  }
  const token = Symbol(config.targetId);
  claims.targets.set(config.targetId, token);
  claims.projects.set(project, token);
  return () => {
    if (claims.targets.get(config.targetId) === token) claims.targets.delete(config.targetId);
    if (claims.projects.get(project) === token) claims.projects.delete(project);
  };
}

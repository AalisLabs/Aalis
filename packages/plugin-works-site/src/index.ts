import { doctor } from '@aalis/api-doctor';
import { publicWorkUrl, publish, type SurfaceBinding } from '@aalis/api-publish';
import { storage } from '@aalis/api-storage';
import { webuiServer } from '@aalis/api-webui';
import { appService, config, definePlugin, events, lifecycle, logger, optional } from '@aalis/core';
import { parseConfig } from '@aalis/schema-config';
import { PagesClient } from './cloudflare/client.js';
import { configSchema, resolveConfig } from './config.js';
import { WorksDeployer } from './deploy.js';
import { registerWorksDoctor } from './doctor.js';
import { claimWorksTarget } from './ownership.js';
import { WorksStore } from './state.js';
import { registerWorksPage } from './webui.js';

export default definePlugin({
  name: '@aalis/plugin-works-site',
  displayName: '作品站',
  subsystem: 'agent',
  reusable: true,
  configSchema,
  uses: {
    config,
    events,
    lifecycle,
    logger,
    app: appService,
    storage,
    publish: optional(publish),
    webui: optional(webuiServer),
    doctor: optional(doctor),
  },
  async apply(caps) {
    const cfg = resolveConfig(parseConfig(configSchema, caps.config.use, caps.logger.use));
    const release = claimWorksTarget(caps.app.use, cfg);
    caps.lifecycle.use.onDispose(release);
    try {
      const storage = caps.storage.use;
      const store = new WorksStore(storage, caps.lifecycle.use.id);
      await store.load();
      await store.bindScope(cfg);
      const client = new PagesClient({
        accountId: cfg.accountId,
        apiToken: cfg.apiToken,
        projectName: cfg.projectName,
        logger: caps.logger.use,
        signal: caps.lifecycle.use.signal,
      });
      let binding: SurfaceBinding | undefined;
      const deployer = new WorksDeployer({
        config: cfg,
        store,
        client,
        publish: () => (caps.publish.present ? caps.publish.use : undefined),
        live: ids => binding?.live(ids),
        logger: caps.logger.use,
        signal: caps.lifecycle.use.signal,
      });
      binding = caps.publish.use.attachSurface({
        name: cfg.targetId,
        label: cfg.siteTitle,
        baseUrl: `${cfg.siteOrigin}${cfg.basePath}`,
        urlFor: id => publicWorkUrl(`${cfg.siteOrigin}${cfg.basePath}`, id),
        health: () => deployer.health(),
      });
      caps.publish.follow(() => {
        deployer.providerChanged();
      });
      caps.publish.use.onChange(() => deployer.change());
      registerWorksPage({ webui: caps.webui.use, publish: caps.publish, store, deployer, config: cfg });
      registerWorksDoctor({ doctor: caps.doctor.use, config: cfg, deployer, store });
      caps.lifecycle.use.onDrain(async () => {
        await deployer.stop();
        release();
      }, '作品站停止部署与本机定时器');
      // Do not perform Pages requests during apply/startup barrier.
      caps.events.use.on('app:started', () => deployer.start());
    } catch (error) {
      release();
      throw error;
    }
  },
});

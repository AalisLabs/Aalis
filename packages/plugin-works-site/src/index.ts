import { doctor } from '@aalis/api-doctor';
import { publicWorkUrl, publish, type SurfaceBinding } from '@aalis/api-publish';
import { createStorageGateway, storage } from '@aalis/api-storage';
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
    const cfg = resolveConfig(parseConfig(configSchema, caps.config, caps.logger));
    const release = claimWorksTarget(caps.app.require(), cfg);
    caps.lifecycle.onDispose(release);
    try {
      const storage = createStorageGateway(caps.storage);
      const store = new WorksStore(storage, caps.lifecycle.id);
      await store.load();
      await store.bindScope(cfg);
      const client = new PagesClient({
        accountId: cfg.accountId,
        apiToken: cfg.apiToken,
        projectName: cfg.projectName,
        logger: caps.logger,
        signal: caps.lifecycle.signal,
      });
      let binding: SurfaceBinding | undefined;
      const deployer = new WorksDeployer({
        config: cfg,
        store,
        client,
        publish: () => caps.publish.current,
        live: ids => binding?.live(ids),
        logger: caps.logger,
        signal: caps.lifecycle.signal,
      });
      binding = caps.publish.attachSurface({
        name: cfg.targetId,
        label: cfg.siteTitle,
        baseUrl: `${cfg.siteOrigin}${cfg.basePath}`,
        urlFor: id => publicWorkUrl(`${cfg.siteOrigin}${cfg.basePath}`, id),
        health: () => deployer.health(),
      });
      caps.publish.follow(() => {
        deployer.providerChanged();
      });
      caps.publish.onChange(() => deployer.change());
      registerWorksPage({ webui: caps.webui, publish: caps.publish, store, deployer, config: cfg });
      registerWorksDoctor({ doctor: caps.doctor, config: cfg, deployer, store });
      caps.lifecycle.onDrain(async () => {
        await deployer.stop();
        release();
      }, '作品站停止部署与本机定时器');
      // Do not perform Pages requests during apply/startup barrier.
      caps.events.on('app:started', () => deployer.start());
    } catch (error) {
      release();
      throw error;
    }
  },
});

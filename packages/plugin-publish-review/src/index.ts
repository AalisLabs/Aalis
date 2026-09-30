import { dirname, join } from 'node:path';
import { codeSandbox } from '@aalis/api-code-sandbox';
import { doctor } from '@aalis/api-doctor';
import { gateway } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { llm } from '@aalis/api-llm';
import { publish } from '@aalis/api-publish';
import { createStorageGateway, storage } from '@aalis/api-storage';
import { webuiServer } from '@aalis/api-webui';
import { config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { parseConfig } from '@aalis/schema-config';
import { OfflineRenderer } from '@aalis/util-offline-render';
import { configSchema } from './config.js';
import { registerReviewDoctor } from './doctor.js';
import { ReviewDriver } from './driver.js';
import { ReviewNotices } from './notices.js';
import { createReviewPipeline } from './pipeline.js';
import { ReviewPreviewServer } from './preview.js';
import { PublishReviewService } from './service.js';
import { ReviewStore } from './state.js';
import { registerReviewPage } from './webui.js';

export default definePlugin({
  name: '@aalis/plugin-publish-review',
  displayName: '作品审核',
  subsystem: 'agent',
  configSchema,
  provides: [publish],
  uses: {
    config,
    events,
    lifecycle,
    logger,
    provide,
    storage,
    hooks,
    gateway: optional(gateway),
    llm: optional(llm),
    sandbox: optional(codeSandbox),
    webui: optional(webuiServer),
    doctor: optional(doctor),
  },
  async apply(caps) {
    const cfg = parseConfig(configSchema, caps.config, caps.logger);
    const storage = createStorageGateway(caps.storage);
    const store = new ReviewStore(storage);
    await store.load();
    const renderer = new OfflineRenderer({
      sandbox: 'required',
      headless: cfg.chrome.headless,
      executablePath: cfg.chrome.executablePath || undefined,
      logger: caps.logger,
    });
    const ffprobePath = /[/\\]/.test(cfg.ffmpegPath) ? join(dirname(cfg.ffmpegPath), 'ffprobe') : 'ffprobe';
    const pipeline = createReviewPipeline({
      config: cfg,
      storage,
      llm: caps.llm,
      sandbox: caps.sandbox,
      renderer,
      ffmpegPath: cfg.ffmpegPath,
      ffprobePath,
    });
    const notices = new ReviewNotices(caps.events, caps.logger, caps.gateway, caps.hooks);
    const service = new PublishReviewService({
      storage,
      store,
      config: cfg,
      pipeline,
      signal: caps.lifecycle.signal,
      notice: (origin, content, id, title) => notices.enqueue(origin, content, id, title),
    });
    const driver = new ReviewDriver(service, store, caps.lifecycle.signal, caps.logger);
    const preview = new ReviewPreviewServer({ store, storage, signal: caps.lifecycle.signal });
    const off = service.onQueueChange(() => preview.prune());
    caps.lifecycle.onDrain(async () => {
      off();
      preview.close();
      await Promise.all([driver.stop(), service.close(), notices.close(), renderer.dispose()]);
    }, '作品审核停止出队、通知、预览与渲染');
    registerReviewPage({
      webui: caps.webui,
      service,
      store,
      storage,
      preview,
      ownerTimeoutHours: cfg.ownerTimeoutHours,
      reviewEnabled: cfg.reviewEnabled,
    });
    registerReviewDoctor({
      doctor: caps.doctor,
      store,
      config: cfg,
      llm: caps.llm,
      sandbox: caps.sandbox,
      renderer,
      ffprobePath,
      signal: caps.lifecycle.signal,
    });
    caps.provide(publish, service);
    // sticky 事件覆盖热启用；回调只开后台任务，不让慢审核阻塞应用启动屏障。
    caps.events.on('app:started', () => {
      notices.open();
      driver.start();
    });
  },
});

import type { CodeSandboxService } from '@aalis/api-code-sandbox';
import type { BoundDoctor, CheckResult } from '@aalis/api-doctor';
import { type LLMModel, resolveLLMModel } from '@aalis/api-llm';
import type { ServiceSelection } from '@aalis/core';
import { type TextRef, textClauses } from '@aalis/schema-i18n';
import type { OfflineRenderer } from '@aalis/util-offline-render';
import type { ReviewConfig } from './config.js';
import { AUDIT, type ReviewStore } from './state.js';
import { t } from './texts.js';

export function registerReviewDoctor(deps: {
  doctor: BoundDoctor;
  store: ReviewStore;
  config: ReviewConfig;
  llm: ServiceSelection<LLMModel>;
  sandbox: ServiceSelection<CodeSandboxService>;
  renderer: OfflineRenderer;
  ffprobePath: string;
  signal: AbortSignal;
}): void {
  deps.doctor.registerCheck({
    id: 'publish-review.tools',
    category: 'service',
    async run(): Promise<CheckResult> {
      const warnings: TextRef[] = [];
      if (deps.store.failure)
        return { id: 'publish-review.tools', category: 'service', level: 'error', message: deps.store.failure };
      if (deps.store.auditFailure) warnings.push(deps.store.auditFailure);
      const abandoned = Object.values(deps.store.data.notices).filter(n => n.abandoned !== undefined).length;
      if (abandoned > 0) warnings.push(t('abandonedNotices', { count: abandoned }));
      if (deps.config.reviewEnabled) {
        const text = deps.config.textClassifier;
        if (!text?.provider || !text.model || !resolveLLMModel(deps.llm, text))
          warnings.push(t('textClassifierMissing'));
        const image = deps.config.imageClassifier ?? text;
        if (!image?.provider || !image.model || !resolveLLMModel(deps.llm, image, ['vision']))
          warnings.push(t('imageClassifierMissing'));
      }
      const sandbox = deps.sandbox.present ? deps.sandbox.use : undefined;
      if (!sandbox?.available) warnings.push(t('sandboxMissing'));
      else
        for (const [label, cmd] of [
          ['ffmpeg', deps.config.ffmpegPath],
          ['ffprobe', deps.ffprobePath],
        ]) {
          try {
            await sandbox.run({
              cmd,
              args: ['-version'],
              timeout: 5000,
              signal: deps.signal,
              policy: { fsRead: [], fsWrite: [], network: 'deny' },
            });
          } catch {
            warnings.push(t('toolMissing', { tool: label }));
          }
        }
      if (deps.config.reviewEnabled) {
        try {
          const entry = 'https://render.invalid/diagnostic/';
          await deps.renderer.renderPng({
            entry,
            resources: new Map([
              [
                entry,
                {
                  body: new TextEncoder().encode('<!doctype html><html><body>ok</body></html>'),
                  contentType: 'text/html',
                },
              ],
            ]),
            viewport: { width: 1, height: 1 },
            clip: { kind: 'viewport' },
            signal: deps.signal,
          });
        } catch {
          warnings.push(t('rendererMissing'));
        }
      }
      try {
        if ((await deps.store.storage.own.stat(AUDIT)).size > 5 * 1024 * 1024) warnings.push(t('auditTooLarge'));
      } catch {
        /* 首次还没有审计文件 */
      }
      return {
        id: 'publish-review.tools',
        category: 'service',
        level: warnings.length ? 'warn' : 'ok',
        message: deps.config.reviewEnabled
          ? warnings.length
            ? textClauses(warnings)
            : t('reviewReady', { count: Object.keys(deps.store.data.queue).length })
          : textClauses([t('reviewOff', { count: Object.keys(deps.store.data.queue).length }), ...warnings]),
      };
    },
  });
}

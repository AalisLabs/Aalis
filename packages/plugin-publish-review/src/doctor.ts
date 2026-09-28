import type { CodeSandboxService } from '@aalis/api-code-sandbox';
import type { BoundDoctor, CheckResult } from '@aalis/api-doctor';
import { type LLMModel, resolveLLMModel } from '@aalis/api-llm';
import type { ServiceRef } from '@aalis/core';
import type { OfflineRenderer } from '@aalis/util-offline-render';
import type { ReviewConfig } from './config.js';
import type { ReviewStore } from './state.js';

export function registerReviewDoctor(deps: {
  doctor: BoundDoctor;
  store: ReviewStore;
  config: ReviewConfig;
  llm: ServiceRef<LLMModel>;
  sandbox: ServiceRef<CodeSandboxService>;
  renderer: OfflineRenderer;
  ffprobePath: string;
  signal: AbortSignal;
}): void {
  deps.doctor.registerCheck({
    id: 'publish-review.tools',
    category: 'service',
    async run(): Promise<CheckResult> {
      const warnings: string[] = [];
      if (deps.store.failure)
        return { id: 'publish-review.tools', category: 'service', level: 'error', message: deps.store.failure };
      if (deps.store.auditFailure) warnings.push(deps.store.auditFailure);
      const text = deps.config.textClassifier;
      if (!text?.provider || !text.model || !resolveLLMModel(deps.llm, text)) warnings.push('文本分类器未配置或不在场');
      const image = deps.config.imageClassifier ?? text;
      if (!image?.provider || !image.model || !resolveLLMModel(deps.llm, image, ['vision']))
        warnings.push('图像分类器不可用或没有视觉能力');
      const sandbox = deps.sandbox.current;
      if (!sandbox?.available) warnings.push('代码沙箱不可用，不能处理媒体');
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
            warnings.push(`${label} 不可用`);
          }
        }
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
        warnings.push('带沙箱的离线渲染不可用');
      }
      try {
        if ((await deps.store.storage.stat('pluginData:/publish-review/audit.jsonl')).size > 5 * 1024 * 1024)
          warnings.push('审核记录超过 5 MiB');
      } catch {
        /* 首次还没有审计文件 */
      }
      return {
        id: 'publish-review.tools',
        category: 'service',
        level: warnings.length ? 'warn' : 'ok',
        message: warnings.length
          ? warnings.join('；')
          : `审核能力就绪；待审 ${Object.keys(deps.store.data.queue).length} 件`,
      };
    },
  });
}

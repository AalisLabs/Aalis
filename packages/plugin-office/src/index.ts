import { processService } from '@aalis/api-process';
import { isStorageUri, storage } from '@aalis/api-storage';
import { tools, withToolGroups } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, lifecycle, logger, optional } from '@aalis/core';
import { configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { DocSessionManager } from './session.js';
import { t } from './texts.js';
import { registerDocxTools } from './tools/docx.js';
import { registerPdfTools } from './tools/pdf.js';
import { registerPptTools } from './tools/pptx.js';
import { registerExcelTools } from './tools/xlsx.js';

const configSchema = defineConfig({
  outputDir: {
    type: 'string',
    label: t('outputDirLabel'),
    description: t('outputDirDescription'),
    default: 'workspace:/',
    onInvalid: 'error',
  },
  docx: {
    label: t('docxLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('docxEnabledLabel'), default: true, onInvalid: 'error' },
    },
  },
  xlsx: {
    label: t('xlsxLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('xlsxEnabledLabel'), default: true, onInvalid: 'error' },
    },
  },
  pptx: {
    label: t('pptxLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('pptxEnabledLabel'), default: true, onInvalid: 'error' },
    },
  },
  pdf: {
    label: t('pdfLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('pdfEnabledLabel'), default: true, onInvalid: 'error' },
    },
  },
});

// ===== 插件入口 =====

// process 只被 pdf_convert 用到（调 LibreOffice），缺它其余工具照常工作，故 optional。
const uses = { tools, storage, processService: optional(processService), logger, lifecycle, config };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-office',
  displayName: t('displayName'),
  subsystem: 'tools',
  configSchema,
  uses,
  apply: registerOffice,
});

function registerOffice(caps: Caps): void {
  const { logger } = caps;
  const cfg = parseConfig(configSchema, caps.config.use, logger.use);
  const outputUri = cfg.outputDir || configSchema.outputDir.default;
  if (!isStorageUri(outputUri)) {
    throw configError(t('badOutputDir', { value: outputUri }));
  }
  const storage = caps.storage.use;
  const sessions = new DocSessionManager();

  caps.tools.use.registerGroup({
    name: 'office',
    label: t('displayName'),
    summary: t('groupSummary'),
    description: '创建和编辑 Word、Excel、PPT、PDF 文档',
  });

  const tools = withToolGroups(caps.tools.use, ['office']);

  if (cfg.docx.enabled) {
    registerDocxTools(tools, sessions, storage, outputUri);
    logger.use.info('Word (docx) 工具已启用');
  }

  if (cfg.xlsx.enabled) {
    registerExcelTools(tools, sessions, storage, outputUri);
    logger.use.info('Excel (xlsx) 工具已启用');
  }

  if (cfg.pptx.enabled) {
    registerPptTools(tools, sessions, storage, outputUri);
    logger.use.info('PPT (pptx) 工具已启用');
  }

  if (cfg.pdf.enabled) {
    // 缺 process 时不取句柄：pdf_convert 要回「请启用 process 提供方」的明确提示，
    // 而不是让句柄在调用点抛出被当成转换失败
    const proc = caps.processService.present ? caps.processService.use : undefined;
    registerPdfTools(tools, sessions, storage, outputUri, proc);
    logger.use.info('PDF 工具已启用');
  }

  caps.lifecycle.use.onDispose(() => sessions.clear());
  logger.use.info(`Office 文档工具插件已启动 (输出 URI: ${outputUri})`);
}

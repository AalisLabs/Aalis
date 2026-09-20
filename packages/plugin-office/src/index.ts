import { createProcessGateway, processService } from '@aalis/api-process';
import { createStorageGateway, storage } from '@aalis/api-storage';
import { tools, withToolGroups } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, lifecycle, logger, optional } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { DocSessionManager } from './session.js';
import { registerDocxTools } from './tools/docx.js';
import { registerPdfTools } from './tools/pdf.js';
import { registerPptTools } from './tools/pptx.js';
import { registerExcelTools } from './tools/xlsx.js';

const configSchema: ConfigSchema = {
  outputDir: {
    type: 'string',
    label: '输出目录',
    description: '文档保存目录（storage URI，如 workspace:/ 或 data:/docs），也兼容裸名「workspace」/「data」。',
    default: 'workspace:/',
  },
  docx: {
    label: 'Word 文档',
    fields: {
      enabled: { type: 'boolean', label: '启用 Word 工具', default: true },
    },
  },
  xlsx: {
    label: 'Excel 工作簿',
    fields: {
      enabled: { type: 'boolean', label: '启用 Excel 工具', default: true },
    },
  },
  pptx: {
    label: 'PPT 演示文稿',
    fields: {
      enabled: { type: 'boolean', label: '启用 PPT 工具', default: true },
    },
  },
  pdf: {
    label: 'PDF 文档',
    fields: {
      enabled: { type: 'boolean', label: '启用 PDF 工具', default: true },
    },
  },
};

// ===== 配置类型 =====

interface OfficeConfig {
  outputDir: string;
  docx: { enabled: boolean };
  xlsx: { enabled: boolean };
  pptx: { enabled: boolean };
  pdf: { enabled: boolean };
}

// ===== 插件入口 =====

// process 只被 pdf_convert 用到（调 LibreOffice），缺它其余工具照常工作，故 optional。
const uses = { tools, storage, processService: optional(processService), logger, lifecycle, config };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-office',
  displayName: 'Office 文档工具',
  subsystem: 'tools',
  configSchema,
  uses,
  apply: registerOffice,
});

function registerOffice(caps: Caps): void {
  const { logger } = caps;
  const cfg = resolveConfig(caps.config);
  const storage = createStorageGateway(caps.storage);
  const outputUri = toUri(cfg.outputDir);
  const sessions = new DocSessionManager();

  caps.tools.registerGroup({
    name: 'office',
    label: 'Office 文档工具',
    description: '创建和编辑 Word、Excel、PPT、PDF 文档',
  });

  const tools = withToolGroups(caps.tools, ['office']);

  if (cfg.docx.enabled) {
    registerDocxTools(tools, sessions, storage, outputUri);
    logger.info('Word (docx) 工具已启用');
  }

  if (cfg.xlsx.enabled) {
    registerExcelTools(tools, sessions, storage, outputUri);
    logger.info('Excel (xlsx) 工具已启用');
  }

  if (cfg.pptx.enabled) {
    registerPptTools(tools, sessions, storage, outputUri);
    logger.info('PPT (pptx) 工具已启用');
  }

  if (cfg.pdf.enabled) {
    // 不给网关兜底：缺 process 时 pdf_convert 要回「请启用 process 提供方」的明确提示，
    // 而不是让网关在调用点抛出被当成转换失败
    const proc = caps.processService.current ? createProcessGateway(caps.processService) : undefined;
    registerPdfTools(tools, sessions, storage, outputUri, proc);
    logger.info('PDF 工具已启用');
  }

  caps.lifecycle.onDispose(() => sessions.clear());
  logger.info(`Office 文档工具插件已启动 (输出 URI: ${outputUri})`);
}

// ===== 辅助函数 =====

/** 兼容 裸名/相对路径 → storage URI */
function toUri(input: string): string {
  if (input.includes(':/')) return input;
  const s = input.trim().replace(/^\.?\/+/, '');
  const idx = s.indexOf('/');
  return idx > 0 ? `${s.slice(0, idx)}:/${s.slice(idx + 1)}` : `${s}:/`;
}

function resolveConfig(config: Readonly<Record<string, unknown>>): OfficeConfig {
  const docx = config.docx as Record<string, unknown> | undefined;
  const xlsx = config.xlsx as Record<string, unknown> | undefined;
  const pptx = config.pptx as Record<string, unknown> | undefined;
  const pdf = config.pdf as Record<string, unknown> | undefined;
  return {
    outputDir: String(config.outputDir || 'workspace:/'),
    docx: { enabled: docx?.enabled !== false },
    xlsx: { enabled: xlsx?.enabled !== false },
    pptx: { enabled: pptx?.enabled !== false },
    pdf: { enabled: pdf?.enabled !== false },
  };
}

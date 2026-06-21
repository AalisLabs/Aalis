import type { ConfigSchema, Context } from '@aalis/core';
import { createProcessGateway } from '@aalis/plugin-process-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import { toolsWithGroups, useToolService } from '@aalis/plugin-tools-api';
import { DocSessionManager } from './session.js';
import { registerDocxTools } from './tools/docx.js';
import { registerPdfTools } from './tools/pdf.js';
import { registerPptTools } from './tools/pptx.js';
import { registerExcelTools } from './tools/xlsx.js';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-office';
export const displayName = 'Office 文档工具';
export const subsystem = 'tools';
export const inject = {
  required: ['storage', 'tools'],
  optional: ['process'],
};

export const configSchema: ConfigSchema = {
  outputDir: {
    type: 'string',
    label: '输出目录',
    description: '文档保存目录（storage URI，如 workspace:/ 或 data:/docs），也兼容裸名「workspace」/「data」。',
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

export const defaultConfig = {
  outputDir: 'workspace:/',
  docx: { enabled: true },
  xlsx: { enabled: true },
  pptx: { enabled: true },
  pdf: { enabled: true },
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

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  const storage = createStorageGateway(ctx);
  // 兼容 裸名/相对路径 → storage URI
  function toUri(input: string): string {
    if (input.includes(':/')) return input;
    const s = input.trim().replace(/^\.?\/+/, '');
    const idx = s.indexOf('/');
    return idx > 0 ? `${s.slice(0, idx)}:/${s.slice(idx + 1)}` : `${s}:/`;
  }
  const outputUri = toUri(cfg.outputDir);
  const sessions = new DocSessionManager();

  const baseTools = useToolService(ctx);
  baseTools.registerGroup({
    name: 'office',
    label: 'Office 文档工具',
    description: '创建和编辑 Word、Excel、PPT、PDF 文档',
  });

  const tools = toolsWithGroups(baseTools, ['office']);

  if (cfg.docx.enabled) {
    registerDocxTools(tools, sessions, storage, outputUri);
    ctx.logger.info('Word (docx) 工具已启用');
  }

  if (cfg.xlsx.enabled) {
    registerExcelTools(tools, sessions, storage, outputUri);
    ctx.logger.info('Excel (xlsx) 工具已启用');
  }

  if (cfg.pptx.enabled) {
    registerPptTools(tools, sessions, storage, outputUri);
    ctx.logger.info('PPT (pptx) 工具已启用');
  }

  if (cfg.pdf.enabled) {
    const proc = ctx.hasService('process') ? createProcessGateway(ctx) : undefined;
    registerPdfTools(tools, sessions, storage, outputUri, proc);
    ctx.logger.info('PDF 工具已启用');
  }

  ctx.onDispose(() => sessions.clear());
  ctx.logger.info(`Office 文档工具插件已启动 (输出 URI: ${outputUri})`);
}

// ===== 辅助函数 =====

function resolveConfig(config: Record<string, unknown>): OfficeConfig {
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

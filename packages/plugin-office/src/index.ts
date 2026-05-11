import { resolve } from 'node:path';
import type { ConfigSchema, Context } from '@aalis/core';
import { DocSessionManager } from './session.js';
import { registerDocxTools } from './tools/docx.js';
import { registerPdfTools } from './tools/pdf.js';
import { registerPptTools } from './tools/pptx.js';
import { registerExcelTools } from './tools/xlsx.js';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-office';
export const displayName = 'Office 文档工具';

export const configSchema: ConfigSchema = {
  outputDir: {
    type: 'string',
    label: '输出目录',
    description: '文档保存目录（相对于工作目录或绝对路径）',
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
  outputDir: 'workspace',
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
  const outputDir = resolve(process.cwd(), cfg.outputDir);
  const sessions = new DocSessionManager();

  function ctxWithGroups(groups: string[]): Context {
    return new Proxy(ctx, {
      get(target, prop) {
        if (prop === 'registerTool') {
          return (tool: Parameters<Context['registerTool']>[0]) => target.registerTool({ ...tool, groups });
        }
        return Reflect.get(target, prop, target);
      },
    }) as Context;
  }

  ctx.registerToolGroup({
    name: 'office',
    label: 'Office 文档工具',
    description: '创建和编辑 Word、Excel、PPT、PDF 文档',
  });

  const groupCtx = ctxWithGroups(['office']);

  if (cfg.docx.enabled) {
    registerDocxTools(groupCtx, sessions, outputDir);
    ctx.logger.info('Word (docx) 工具已启用');
  }

  if (cfg.xlsx.enabled) {
    registerExcelTools(groupCtx, sessions, outputDir);
    ctx.logger.info('Excel (xlsx) 工具已启用');
  }

  if (cfg.pptx.enabled) {
    registerPptTools(groupCtx, sessions, outputDir);
    ctx.logger.info('PPT (pptx) 工具已启用');
  }

  if (cfg.pdf.enabled) {
    registerPdfTools(groupCtx, sessions, outputDir);
    ctx.logger.info('PDF 工具已启用');
  }

  ctx.logger.info(`Office 文档工具插件已启动 (输出目录: ${outputDir})`);
}

// ===== 辅助函数 =====

function resolveConfig(config: Record<string, unknown>): OfficeConfig {
  const docx = config.docx as Record<string, unknown> | undefined;
  const xlsx = config.xlsx as Record<string, unknown> | undefined;
  const pptx = config.pptx as Record<string, unknown> | undefined;
  const pdf = config.pdf as Record<string, unknown> | undefined;
  return {
    outputDir: String(config.outputDir || 'workspace'),
    docx: { enabled: docx?.enabled !== false },
    xlsx: { enabled: xlsx?.enabled !== false },
    pptx: { enabled: pptx?.enabled !== false },
    pdf: { enabled: pdf?.enabled !== false },
  };
}

import type { ConfigSchema, Context } from '@aalis/core';
import { toolsWithGroups, useToolService } from '@aalis/plugin-tools-api';
import { registerBaseConvertTools } from './tools/base-convert.js';
import { registerCalculusTools } from './tools/calculus.js';
import { registerConversionTools } from './tools/conversion.js';
import { registerEquationTools } from './tools/equation.js';
import { registerEvaluateTools } from './tools/evaluate.js';
import { registerFinancialTools } from './tools/financial.js';
import { registerGeometryTools } from './tools/geometry.js';
import { registerMatrixTools } from './tools/matrix.js';
import { registerNumberTheoryTools } from './tools/number-theory.js';
import { registerStatisticsTools } from './tools/statistics.js';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tool-math';
export const displayName = '数学工具';
export const subsystem = 'tools';

export const configSchema: ConfigSchema = {
  evaluate: {
    label: '表达式计算',
    fields: {
      enabled: { type: 'boolean', label: '启用表达式计算工具', default: true },
    },
  },
  statistics: {
    label: '统计分析',
    fields: {
      enabled: { type: 'boolean', label: '启用统计分析工具', default: true },
    },
  },
  matrix: {
    label: '矩阵运算',
    fields: {
      enabled: { type: 'boolean', label: '启用矩阵运算工具', default: true },
    },
  },
  numberTheory: {
    label: '数论与组合',
    fields: {
      enabled: { type: 'boolean', label: '启用数论工具', default: true },
    },
  },
  geometry: {
    label: '几何计算',
    fields: {
      enabled: { type: 'boolean', label: '启用几何计算工具', default: true },
    },
  },
  conversion: {
    label: '单位换算',
    fields: {
      enabled: { type: 'boolean', label: '启用单位换算工具', default: true },
    },
  },
  financial: {
    label: '金融数学',
    fields: {
      enabled: { type: 'boolean', label: '启用金融数学工具', default: true },
    },
  },
  calculus: {
    label: '微积分',
    fields: {
      enabled: { type: 'boolean', label: '启用微积分工具', default: true },
    },
  },
  equation: {
    label: '方程求解',
    fields: {
      enabled: { type: 'boolean', label: '启用方程求解工具', default: true },
    },
  },
  baseConvert: {
    label: '进制转换',
    fields: {
      enabled: { type: 'boolean', label: '启用进制转换工具', default: true },
    },
  },
};

// ===== 配置类型 =====

interface ToolMathConfig {
  evaluate: { enabled: boolean };
  statistics: { enabled: boolean };
  matrix: { enabled: boolean };
  numberTheory: { enabled: boolean };
  geometry: { enabled: boolean };
  conversion: { enabled: boolean };
  financial: { enabled: boolean };
  calculus: { enabled: boolean };
  equation: { enabled: boolean };
  baseConvert: { enabled: boolean };
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const tools = useToolService(ctx);
  const cfg = resolveConfig(config);

  // 注册工具分组
  tools.registerGroup({
    name: 'math',
    label: '数学工具',
    description: '表达式计算、统计分析、矩阵运算、数论、几何、单位换算、金融数学、微积分、方程求解、进制转换',
  });

  const grouped = toolsWithGroups(tools, ['math']);

  if (cfg.evaluate.enabled) {
    registerEvaluateTools(grouped);
    ctx.logger.info('表达式计算工具已启用');
  }

  if (cfg.statistics.enabled) {
    registerStatisticsTools(grouped);
    ctx.logger.info('统计分析工具已启用');
  }

  if (cfg.matrix.enabled) {
    registerMatrixTools(grouped);
    ctx.logger.info('矩阵运算工具已启用');
  }

  if (cfg.numberTheory.enabled) {
    registerNumberTheoryTools(grouped);
    ctx.logger.info('数论与组合工具已启用');
  }

  if (cfg.geometry.enabled) {
    registerGeometryTools(grouped);
    ctx.logger.info('几何计算工具已启用');
  }

  if (cfg.conversion.enabled) {
    registerConversionTools(grouped);
    ctx.logger.info('单位换算工具已启用');
  }

  if (cfg.financial.enabled) {
    registerFinancialTools(grouped);
    ctx.logger.info('金融数学工具已启用');
  }

  if (cfg.calculus.enabled) {
    registerCalculusTools(grouped);
    ctx.logger.info('微积分工具已启用');
  }

  if (cfg.equation.enabled) {
    registerEquationTools(grouped);
    ctx.logger.info('方程求解工具已启用');
  }

  if (cfg.baseConvert.enabled) {
    registerBaseConvertTools(grouped);
    ctx.logger.info('进制转换工具已启用');
  }

  ctx.logger.info('数学工具插件已启动');
}

// ===== 辅助函数 =====

function resolveConfig(config: Record<string, unknown>): ToolMathConfig {
  const get = (key: string) => {
    const section = config[key] as Record<string, unknown> | undefined;
    return { enabled: section?.enabled !== false };
  };
  return {
    evaluate: get('evaluate'),
    statistics: get('statistics'),
    matrix: get('matrix'),
    numberTheory: get('numberTheory'),
    geometry: get('geometry'),
    conversion: get('conversion'),
    financial: get('financial'),
    calculus: get('calculus'),
    equation: get('equation'),
    baseConvert: get('baseConvert'),
  };
}

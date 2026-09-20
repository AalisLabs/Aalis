import { type BoundTools, tools, withToolGroups } from '@aalis/api-tools';
import { config, definePlugin, logger, optional } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
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
import { registerSymbolicTools } from './tools/symbolic.js';

// ===== 插件配置 =====

const configSchema: ConfigSchema = {
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
  symbolic: {
    label: '符号代数 (mathjs)',
    fields: {
      enabled: {
        type: 'boolean',
        label: '启用符号计算工具',
        default: true,
        description: '符号求导、化简、有理化、LaTeX 输出等，基于 mathjs',
      },
    },
  },
};

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
  symbolic: { enabled: boolean };
}

// ===== 插件入口 =====

// 工具服务声明为可选：本插件是纯工具集，tools 缺席时只是没有落脚处（登记排队等提供者），
// 不构成激活前提。
const uses = { tools: optional(tools), config, logger };

export default definePlugin({
  name: '@aalis/plugin-tool-math',
  displayName: '数学工具',
  subsystem: 'tools',
  configSchema,
  uses,
  apply({ tools, config, logger }) {
    const cfg = resolveConfig(config);

    tools.registerGroup({
      name: 'math',
      label: '数学工具',
      description: '表达式计算、统计分析、矩阵运算、数论、几何、单位换算、金融数学、微积分、方程求解、进制转换',
    });

    const grouped: BoundTools = withToolGroups(tools, ['math']);

    if (cfg.evaluate.enabled) {
      registerEvaluateTools(grouped);
      logger.info('表达式计算工具已启用');
    }

    if (cfg.statistics.enabled) {
      registerStatisticsTools(grouped);
      logger.info('统计分析工具已启用');
    }

    if (cfg.matrix.enabled) {
      registerMatrixTools(grouped);
      logger.info('矩阵运算工具已启用');
    }

    if (cfg.numberTheory.enabled) {
      registerNumberTheoryTools(grouped);
      logger.info('数论与组合工具已启用');
    }

    if (cfg.geometry.enabled) {
      registerGeometryTools(grouped);
      logger.info('几何计算工具已启用');
    }

    if (cfg.conversion.enabled) {
      registerConversionTools(grouped);
      logger.info('单位换算工具已启用');
    }

    if (cfg.financial.enabled) {
      registerFinancialTools(grouped);
      logger.info('金融数学工具已启用');
    }

    if (cfg.calculus.enabled) {
      registerCalculusTools(grouped);
      logger.info('微积分工具已启用');
    }

    if (cfg.equation.enabled) {
      registerEquationTools(grouped);
      logger.info('方程求解工具已启用');
    }

    if (cfg.baseConvert.enabled) {
      registerBaseConvertTools(grouped);
      logger.info('进制转换工具已启用');
    }

    if (cfg.symbolic.enabled) {
      registerSymbolicTools(grouped);
      logger.info('符号代数工具已启用 (mathjs)');
    }

    logger.info('数学工具插件已启动');
  },
});

// ===== 辅助函数 =====

function resolveConfig(config: Readonly<Record<string, unknown>>): ToolMathConfig {
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
    symbolic: get('symbolic'),
  };
}

import { type BoundTools, tools, withToolGroups } from '@aalis/api-tools';
import { config, definePlugin, logger, optional } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';
import { t } from './texts.js';
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

const configSchema = defineConfig({
  evaluate: {
    label: t('evaluateLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('evaluateEnabledLabel'), default: true },
    },
  },
  statistics: {
    label: t('statisticsLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('statisticsEnabledLabel'), default: true },
    },
  },
  matrix: {
    label: t('matrixLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('matrixEnabledLabel'), default: true },
    },
  },
  numberTheory: {
    label: t('numberTheoryLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('numberTheoryEnabledLabel'), default: true },
    },
  },
  geometry: {
    label: t('geometryLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('geometryEnabledLabel'), default: true },
    },
  },
  conversion: {
    label: t('conversionLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('conversionEnabledLabel'), default: true },
    },
  },
  financial: {
    label: t('financialLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('financialEnabledLabel'), default: true },
    },
  },
  calculus: {
    label: t('calculusLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('calculusEnabledLabel'), default: true },
    },
  },
  equation: {
    label: t('equationLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('equationEnabledLabel'), default: true },
    },
  },
  baseConvert: {
    label: t('baseConvertLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('baseConvertEnabledLabel'), default: true },
    },
  },
  symbolic: {
    label: t('symbolicLabel'),
    fields: {
      enabled: {
        type: 'boolean',
        label: t('symbolicEnabledLabel'),
        default: true,
        description: t('symbolicEnabledDescription'),
      },
    },
  },
});

// ===== 插件入口 =====

// 工具服务声明为可选：本插件是纯工具集，tools 缺席时只是没有落脚处（登记排队等提供者），
// 不构成激活前提。
const uses = { tools: optional(tools), config, logger };

export default definePlugin({
  name: '@aalis/plugin-tool-math',
  displayName: t('displayName'),
  subsystem: 'tools',
  configSchema,
  uses,
  apply({ tools, config, logger }) {
    const cfg = parseConfig(configSchema, config.use, logger.use);

    tools.use.registerGroup({
      name: 'math',
      label: t('displayName'),
      summary: t('groupSummary'),
      description: '表达式计算、统计分析、矩阵运算、数论、几何、单位换算、金融数学、微积分、方程求解、进制转换',
    });

    const grouped: BoundTools = withToolGroups(tools.use, ['math']);

    if (cfg.evaluate.enabled) {
      registerEvaluateTools(grouped);
      logger.use.info('表达式计算工具已启用');
    }

    if (cfg.statistics.enabled) {
      registerStatisticsTools(grouped);
      logger.use.info('统计分析工具已启用');
    }

    if (cfg.matrix.enabled) {
      registerMatrixTools(grouped);
      logger.use.info('矩阵运算工具已启用');
    }

    if (cfg.numberTheory.enabled) {
      registerNumberTheoryTools(grouped);
      logger.use.info('数论与组合工具已启用');
    }

    if (cfg.geometry.enabled) {
      registerGeometryTools(grouped);
      logger.use.info('几何计算工具已启用');
    }

    if (cfg.conversion.enabled) {
      registerConversionTools(grouped);
      logger.use.info('单位换算工具已启用');
    }

    if (cfg.financial.enabled) {
      registerFinancialTools(grouped);
      logger.use.info('金融数学工具已启用');
    }

    if (cfg.calculus.enabled) {
      registerCalculusTools(grouped);
      logger.use.info('微积分工具已启用');
    }

    if (cfg.equation.enabled) {
      registerEquationTools(grouped);
      logger.use.info('方程求解工具已启用');
    }

    if (cfg.baseConvert.enabled) {
      registerBaseConvertTools(grouped);
      logger.use.info('进制转换工具已启用');
    }

    if (cfg.symbolic.enabled) {
      registerSymbolicTools(grouped);
      logger.use.info('符号代数工具已启用 (mathjs)');
    }

    logger.use.info('数学工具插件已启动');
  },
});

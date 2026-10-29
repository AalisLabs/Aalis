// 本插件自己的原文字典：显示名（同为工具分组名）与分组概述、配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '数学工具',
  groupSummary: '表达式计算、统计分析、矩阵运算、数论、几何、单位换算、金融数学、微积分、方程求解、进制转换',
  evaluateLabel: '表达式计算',
  evaluateEnabledLabel: '启用表达式计算工具',
  statisticsLabel: '统计分析',
  statisticsEnabledLabel: '启用统计分析工具',
  matrixLabel: '矩阵运算',
  matrixEnabledLabel: '启用矩阵运算工具',
  numberTheoryLabel: '数论与组合',
  numberTheoryEnabledLabel: '启用数论工具',
  geometryLabel: '几何计算',
  geometryEnabledLabel: '启用几何计算工具',
  conversionLabel: '单位换算',
  conversionEnabledLabel: '启用单位换算工具',
  financialLabel: '金融数学',
  financialEnabledLabel: '启用金融数学工具',
  calculusLabel: '微积分',
  calculusEnabledLabel: '启用微积分工具',
  equationLabel: '方程求解',
  equationEnabledLabel: '启用方程求解工具',
  baseConvertLabel: '进制转换',
  baseConvertEnabledLabel: '启用进制转换工具',
  symbolicLabel: '符号代数 (mathjs)',
  symbolicEnabledLabel: '启用符号计算工具',
  symbolicEnabledDescription: '符号求导、化简、有理化、LaTeX 输出等，基于 mathjs',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-tool-math',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

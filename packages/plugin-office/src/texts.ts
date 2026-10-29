// 本插件自己的原文字典：显示名（同为工具分组名）与分组概述、配置项与配置报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'Office 文档工具',
  groupSummary: '创建和编辑 Word、Excel、PPT、PDF 文档',
  outputDirLabel: '输出目录',
  outputDirDescription: '文档保存目录（storage URI，如 workspace:/ 或 data:/docs）。',
  badOutputDir: 'outputDir 必须是 storage URI（如 workspace:/ 或 data:/docs），当前为 "{value}"',
  docxLabel: 'Word 文档',
  docxEnabledLabel: '启用 Word 工具',
  xlsxLabel: 'Excel 工作簿',
  xlsxEnabledLabel: '启用 Excel 工具',
  pptxLabel: 'PPT 演示文稿',
  pptxEnabledLabel: '启用 PPT 工具',
  pdfLabel: 'PDF 文档',
  pdfEnabledLabel: '启用 PDF 工具',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-office',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

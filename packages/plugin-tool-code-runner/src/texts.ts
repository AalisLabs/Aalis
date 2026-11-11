// 本插件自己的原文字典：显示名、工具分组名与概述、配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '代码执行器',
  groupLabel: '代码执行',
  groupSummary: '编写并运行 Python / JavaScript 代码来解决计算、分析、文件处理等问题',
  enableTool: '启用 {tool}',
  interpreterLabel: '解释器路径',
  pythonInterpreterDescription: 'Python 解释器路径或命令名，如 python3、/usr/bin/python3',
  javascriptInterpreterDescription: 'Node.js 解释器路径或命令名',
  maxOutputSizeLabel: '最大输出字节',
  maxOutputSizeDescription: 'stdout/stderr 各自的最大输出字节数',
  workingDirectoryLabel: '逻辑工作目录',
  workingDirectoryDescription:
    '脚本运行的工作目录，填 storage URI，如 workspace:/ 或 tmp:/run；相对路径按 workspace:/ 下解析。',
  sandboxLabel: '代码沙箱',
  modeLabel: '隔离模式',
  modeAuto: '自动（有沙箱则强制隔离，无则拒绝运行）',
  modeNone: '无隔离（裸进程，危险，仅信任环境）',
  modeDescription:
    '「自动」在系统沙箱里运行，只能写工作目录与本次临时目录，默认断网；「无隔离」直接运行，插件启动时告警。沙箱不限制读取本机文件。',
  networkLabel: '子进程网络',
  networkDeny: '断网（推荐）',
  networkAllow: '放开（粗粒度，无法按域名过滤）',
  networkDescription: '仅「隔离模式」选「自动」时生效。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-tool-code-runner',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

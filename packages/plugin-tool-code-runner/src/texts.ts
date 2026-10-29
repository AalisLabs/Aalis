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
    '脚本执行时的 storage URI 工作目录，如 workspace:/ 或 tmp:/run；相对路径会解释为 workspace:/ 下路径。',
  sandboxLabel: '代码沙箱',
  modeLabel: '隔离模式',
  modeAuto: '自动（有沙箱则强制隔离，无则拒绝运行）',
  modeNone: '无隔离（裸进程，危险，仅信任环境）',
  modeDescription:
    'auto：经 code-sandbox 服务（Linux bubblewrap / macOS sandbox-exec）把代码限制在「工作区 + 本次临时目录」、默认断网、只放行白名单环境变量；无可用沙箱后端时拒绝执行（fail-closed）。none：退回无隔离裸进程，每次告警。说明：v1 读放开（解释器需系统库），防的是写出工作区/联网外泄/篡改系统，不防读取本机其它文件。',
  networkLabel: '子进程网络',
  networkDeny: '断网（推荐）',
  networkAllow: '放开（粗粒度，无法按域名过滤）',
  networkDescription:
    '仅 auto 模式生效。deny：脚本内联网（含 fetch）会失败。allow：放开子进程网络（无法按域名白名单过滤）。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-tool-code-runner',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

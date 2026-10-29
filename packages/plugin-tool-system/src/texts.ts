// 本插件自己的原文字典：显示名（同为工具分组名）与分组概述、配置项，/tools 的说明与回复的标题行
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '系统工具',
  groupSummary: 'Shell 命令执行、文件操作、系统信息查询、HTTP 请求等系统级工具',
  workingDirectoryLabel: '初始工作目录',
  workingDirectoryDescription:
    '进程启动时的初始 cwd（unix 心智模型）。agent 可用 cd 工具在会话内切换，不会写回本配置。shell 以本项初始值为基准、不受 cd 影响；code-runner 使用它自己的 workingDirectory 配置。',
  shellLabel: 'Shell 工具',
  shellEnabledLabel: '启用 Shell 工具',
  maxOutputSizeLabel: '最大输出字节',
  fileLabel: '文件工具',
  fileEnabledLabel: '启用文件工具',
  maxReadSizeLabel: '最大读取字节',
  maxSearchBytesLabel: '单次搜索最大扫描字节',
  maxWriteSizeLabel: '最大写入字节',
  allowedRootsLabel: '允许访问的存储根',
  allowedRootsDescription:
    '默认仅 agent 工作区（workspace/tmp），不含 data 等系统根（防裸读 data:/users.json 等）。设为 * 放开全部 readable 根；也可显式列出根名。写入/删除仍受各根自身权限限制。',
  rootAllReadable: '全部可读根',
  rootTmp: '临时目录',
  rootPluginData: '插件数据',
  rootLogs: '日志',
  systemEnabledLabel: '启用系统工具',
  httpLabel: 'HTTP 工具',
  httpEnabledLabel: '启用 HTTP 工具',
  defaultTimeoutLabel: '默认超时 (ms)',
  defaultTimeoutDescription: 'http_request 的默认超时；http_download 不另设超时，等多久由工具执行器的让出时限管',
  maxResponseSizeLabel: '最大响应字节',
  toolsDescription: '列出所有已注册的机器交互工具',
  toolsHeading: '机器交互工具:',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-tool-system',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

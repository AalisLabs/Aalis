// 本插件自己的原文字典：显示名、配置项，连不上服务器时的提示，元数据分组名与两种分组的概述
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'MCP 客户端',
  serversLabel: 'MCP 服务器列表',
  serversDescription: '通过 stdio 连接的 MCP 服务器。每条目至少需要 id 与 command；安全级别按需调整。',
  idLabel: '唯一 ID',
  idDescription: '用于工具命名空间，最终工具名形如 mcp_<id>_<tool>。仅允许字母数字与下划线/中划线。',
  commandLabel: '可执行命令',
  commandDescription: '命令名（如 npx / node / python，按 PATH 查找）或绝对路径。',
  argsLabel: '命令参数',
  argsDescription: '按顺序传给命令的参数列表，每项一个参数（可含空格）。参数里的文件路径请写绝对路径。',
  envLabel: '环境变量',
  envDescription:
    '额外传给子进程的环境变量（KEY → VALUE）。整份作为一个密钥存进 secrets.yaml，WebUI 不回显，改时整份重填。token 等凭据放这里，不要放进命令参数（参数会写进日志）。',
  enabledLabel: '启用',
  enabledDescription: '关闭可临时跳过该 server 而不删除整条配置。',
  visibilityLabel: '工具档位',
  visibilityDescription:
    '该 server 全部工具的档位。auto=按工具注解分档：自称只读→sensitive（等级 1），有破坏提示或未声明→restricted（等级 2）。public 恢复等级 0 全开（0.x 旧默认）。',
  visibilityAuto: 'auto（按注解分档）',
  visibilityPublic: 'public（等级 0 全开）',
  visibilitySensitive: 'sensitive（等级 1）',
  visibilityRestricted: 'restricted（等级 2）',
  connectFailedTitle: 'MCP 服务器「{id}」连不上',
  connectFailedDetail: '检查这台服务器的 command、args 与 env（它要的环境变量），改好后保存配置即重连。原因：{reason}',
  serverGroupSummary: '通过 plugin-mcp-client 桥接的远端 MCP server "{id}"',
  metaGroup: 'MCP / 元数据',
  metaGroupSummary: '让 agent 列出和切换已配置的 MCP server（不能新增/删除条目）',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-mcp-client',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

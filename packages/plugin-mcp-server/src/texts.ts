// 本插件自己的原文字典：显示名、配置项与令牌的校验原因、配置报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'MCP 服务端',
  portLabel: '监听端口',
  portDescription: '必须 1-65535；非法值会报错不启动。要暂停服务请在「插件列表」里禁用本插件。',
  bindLabel: '监听地址',
  bindEmpty: 'bind 不能为空',
  tokenLabel: '访问令牌',
  tokenDescription:
    '外部 MCP 客户端要在请求头带上 Authorization: Bearer <令牌>。至少 32 个可见 ASCII 字符、不含空白，可用 openssl rand -hex 32 生成',
  tokenInvalid: '至少 32 个可见 ASCII 字符（不含空白）',
  toolGroupsLabel: '允许的工具分组',
  toolGroupsDescription: "空列表或 ['*'] = 暴露所有分组的工具（仍受「允许暴露 restricted（受限）工具」约束）。",
  allowRestrictedLabel: '允许暴露 restricted（受限）工具',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-mcp-server',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

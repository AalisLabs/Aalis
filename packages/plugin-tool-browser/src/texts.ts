// 本插件自己的原文字典：显示名、配置项，浏览器页（同为工具分组名）的文字、动作回执与报错，工具分组的概述
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '浏览器工具',
  headlessLabel: '无头模式',
  headlessDescription: '是否以无头模式运行浏览器（无 GUI 窗口）。',
  defaultTimeoutLabel: '默认超时（ms）',
  defaultTimeoutDescription: '页面导航和操作的默认超时时间。',
  viewportWidthLabel: '视口宽度',
  viewportHeightLabel: '视口高度',
  maxPagesLabel: '最大页面数',
  maxPagesDescription: '同时打开的最大页面数量。超出后关闭最早打开的页面。',
  executablePathLabel: 'Chrome 路径',
  executablePathDescription:
    '自定义 Chrome/Chromium 可执行文件的绝对路径。留空时用 puppeteer 配置里的可执行文件（PUPPETEER_EXECUTABLE_PATH、.puppeteerrc），没配时用 puppeteer 自带的 Chrome。',
  sandboxLabel: 'Chromium 沙箱',
  sandboxDescription:
    '打开后 Chromium 带沙箱启动，网页即使攻破渲染进程也出不了沙箱。Linux 上以 root 运行或容器里没有可用的沙箱时，打开后浏览器无法启动。',
  maxContentLengthLabel: '最大内容长度',
  maxContentLengthDescription: '返回给 Agent 的页面文本最大字符数。',
  blockPrivateLabel: '封锁内网与本地',
  blockPrivateDescription:
    '拒绝 localhost / 127.x / ::1 / 10.x / 172.16-31.x / 192.168.x / 169.254.x / 0.0.0.0，防止 SSRF。',
  allowedProtocolsLabel: '允许的协议',
  allowedProtocolsDescription: '浏览器只允许访问这些协议的 URL。',
  allowedHostsLabel: '主机白名单',
  allowedHostsDescription: '允许访问的主机（含内网时需在此显式列出）。留空 = 仅按 blockPrivate 判定。',
  browser: '浏览器',
  groupSummary: '使用 Puppeteer 无头浏览器进行网页导航、内容提取、截图等操作',
  close: '关闭',
  closed: '已关闭 {id}',
  pageMissing: '页面 {id} 不存在',
  closeAll: '关闭所有页面',
  closeAllConfirm: '关闭全部打开的页面？',
  closedAll: '已关闭全部页面',
  openPages: '打开的页面',
  noOpenPages: '没有打开的页面',
  title: '标题',
  url: '地址',
  lastAccess: '最后访问',
  untitled: '（无标题）',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-tool-browser',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

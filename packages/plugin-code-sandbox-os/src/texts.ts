// 本插件自己的原文字典：探测沙箱后端的结论与原因（诊断项交文字对象，日志取原文）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  none: '没有可用的 OS 沙箱，code_runner 的 auto 模式会拒绝执行代码',
  noPlatform: '这个平台（{platform}）没有 OS 沙箱后端：要用沙箱就在 macOS、Linux 或 WSL 上运行 Aalis',
  fixSeatbelt: 'sandbox-exec 是 macOS 自带的，确认 /usr/bin/sandbox-exec 能执行后重载本插件',
  fixBwrap:
    '装上 bubblewrap（bwrap），并开启非特权用户命名空间（unprivileged user namespaces）；在容器里运行时还要能挂 /proc。改好后重载本插件',
  probeFailed: '{fix}。探测 {cmd} 失败：{reason}',
  killed: '被信号 {signal} 终止（含 5 秒超时）',
  exitCode: '退出码 {code}',
  available: 'OS 沙箱可用（{backend}）',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-code-sandbox-os',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

// 脚手架自己的原文字典：终端里显示的句子（提问、提示与报错）。生成的插件里的文字不经这里，按原文语言写在 cli.ts 的表里
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  nonTty: '检测到非交互式环境（stdin 不是 TTY），无法进入交互。请改用：',
  nonTtyYes: '  create-aalis-plugin <包名> --yes    # 全默认（tool 模板）',
  badLanguage: '--lang 只收 zh-CN 或 en（插件的原文语言），不收「{value}」',
  packageNamePrompt: '包名（如 my-plugin 或 @scope/my-plugin）',
  sourceLanguagePrompt: '原文语言（zh-CN 或 en）',
  displayNamePrompt: '显示名',
  toolPrompt: '注册 AI 工具？',
  commandPrompt: '注册斜杠命令？',
  pagePrompt: '提供 WebUI 页面？',
  framePrompt: '页面用自带前端？',
  sessionSettingPrompt: '声明可按会话设的配置项？',
  warning: '  注意：{error}',
  yesOrNo: '请输入 y 或 n。',
  badSourceLanguage: '只收 zh-CN 或 en。',
  nameEmpty: '名称不能为空。',
  nameTooLong: '名称过长（>214 字符）。',
  nameSpace: '名称不能含空格。',
  nameUppercase: '名称必须全小写（npm 包名规则，如 my-plugin）。',
  scopeFormat: 'scope 包名格式应为 @scope/name。',
  scopeInvalid: 'scope「{scope}」非法（须以小写字母/数字开头，仅含 a-z 0-9 . _ -）。',
  nameLeadingDot: '名称不能以 . 或 _ 开头。',
  nameChars: '名称只能含小写字母、数字、- . _，且以字母或数字开头（如 my-plugin）。',
  badPackageName: '非法包名「{name}」：{error}',
  dirExists: '目录已存在：{dir}：换一个插件名，或先移走这个目录',
  versionUnreachable: '查不到 {pkg} 的最新版本：连不上 {url}（{error}）',
  versionStatus: '查不到 {pkg} 的最新版本：{url} 回应 {status}',
  versionNotJson: '查不到 {pkg} 的最新版本：{url} 的回应读不出 JSON（{error}）',
  versionMissing: '查不到 {pkg} 的最新版本：{url} 的回应里没有版本号',
  registryHint:
    '检查网络与代理后重试，或用 --registry <源地址> 指定一个能访问的 npm 源（npm config get registry 可查本机在用的源）。',
  generated: '已生成插件骨架：{dir}',
  nextSteps: '下一步：',
  installLinks: '装进 Aalis 项目：在项目目录里执行 npm install --install-links <本目录路径>，',
  installNpmrc: '并在项目的 .npmrc 写一行 install-links=true（否则下次普通 npm install 会改回符号链接）；',
  installPack: '或在本目录执行 npm pack，再在项目目录 npm install <生成的 .tgz 路径>。不能装成符号链接：',
  installSecondCore: '本目录 devDependencies 里的 @aalis/core 会成为进程里的第二份，插件会被拒绝加载。',
  installLoad:
    '装好后重启实例，或在 WebUI 插件区点「重新扫描」，插件才会加载（插件默认启用；停用是把包名写进 disabledPlugins）。',
} as const;

export type Source = typeof SOURCE;

export const t = defineTexts({ ns: 'create-aalis-plugin', language: 'zh-CN', source: SOURCE, locales: { en } });

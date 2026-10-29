// 本插件自己的原文字典：显示名，不归市场装卸的包种类与装卸时的拒绝，装卸与更新的回执、npm 失败的原因与修法、冲突要点
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '包管理器',
  noApp: 'app 服务不可用，无法执行包管理操作',
  emptyName: '包名必须是非空字符串',
  badName: '非法包名: {name}',
  badVersion: '非法版本号: {name}@{version}',
  noTargets: '未指定更新目标',
  duplicateTarget: '同一包被指定了多次: {name}',
  tooManyTargets: '更新目标过多：参数总长已超 {budget} 字节，请分批提交',
  npmDisk: '磁盘空间不够（ENOSPC）：腾出空间后重试',
  npmPermission:
    '没有写入权限（EACCES）：把项目目录与 npm 的缓存目录（npm config get cache 查看）改回运行 Aalis 的用户所有后重试，不要用 sudo',
  npmPlatform: '依赖 {pkg} 不支持这台机器的系统或 CPU 架构（EBADPLATFORM），这个插件在这里装不了',
  npmPlatformUnknown: '依赖 某个依赖 不支持这台机器的系统或 CPU 架构（EBADPLATFORM），这个插件在这里装不了',
  npmPeer: 'peer 依赖冲突（市场安装不沿用 .npmrc 里的 legacy-peer-deps）：{conflicts}',
  npmBrowser:
    '下载浏览器失败：这个插件装的时候要下载 Chrome。给 Aalis 的进程设好镜像地址（环境变量 PUPPETEER_CHROME_DOWNLOAD_BASE_URL）后重启再装',
  npmNative:
    '原生模块 {pkg} 编译失败：本机缺 C/C++ 编译工具。macOS 执行 xcode-select --install；Linux 装 build-essential 与 python3；Windows 装 Visual Studio 的「使用 C++ 的桌面开发」，装好后重试',
  npmNativeUnknown:
    '原生模块 某个依赖 编译失败：本机缺 C/C++ 编译工具。macOS 执行 xcode-select --install；Linux 装 build-essential 与 python3；Windows 装 Visual Studio 的「使用 C++ 的桌面开发」，装好后重试',
  npmMissing: '源上没有这个包或这个版本（{code}）：核对包名与版本；用的是镜像源时它可能还没同步，稍后重试',
  npmNetwork:
    '连不上 npm 源（{code}）：检查网络与代理后重试；默认源不通时在终端执行 npm config set registry <源地址> 换一个源',
  npmOther: 'npm 出错：{error}。完整输出在日志里，常见原因与修法见 https://aalis.acenyan.com/guide/troubleshooting',
  needsPeer: '{dependent} 需要 {peer}',
  busy: '有包管理操作正在进行中（{operation}），请稍候重试',
  opUpdate: '更新 {names, list}',
  opInstall: '安装 {name}',
  opUninstall: '卸载 {name}',
  installedErrored: '已安装 {target}，但激活失败，已转为 error 态（{error}）',
  seeLogs: '详见日志',
  installedActivating: '已安装 {target}，仍在激活（超过慢激活阈值，已转入后台），结果以插件列表为准',
  installedPending: '已安装 {target}，尚未激活，正在等待 required 依赖满足',
  installedLoaded: '已安装并加载: {target}',
  installedNotLoaded: '已装到 {where}，但它声明为插件却未被加载——请检查其 keywords 与入口导出',
  installedNonPlugin: '已安装 {target}（非插件包，不进入插件列表）',
  workspaceInstall: '根依赖含 workspace: 协议，拒绝在此运行 npm install（会写出 package-lock.json 并搅坏 pnpm 工作区）',
  workspaceUpdate: '根依赖含 workspace: 协议，拒绝在此运行 npm install',
  noRestart: '当前宿主未提供重启能力，无法完成更新',
  noRootPackage: '读不到根 package.json: {path}',
  notUpdatable:
    '以下包不在根依赖中（由其它插件带入）或不是 registry 来源，单独更新只会装出第二份副本；请改为更新带入它们的插件：{names, list}',
  downgradeItem: '{name}（本地 {installed} → 目标 {version}）',
  unknown: '未知',
  notUpgrade: '以下目标版本不高于本地已装版本（或本地版本号读不到），更新会变成降级，已拒绝：{items, list}',
  preflightRejected: '依赖预检未通过，未改动任何文件。若是 peer 版本要求，请把被依赖方一并勾选后重试。',
  preflightFailed: '依赖预检没跑成：{error}',
  installFailedRetry: '安装失败（工程未重启，可重试）：{error}',
  updated: '已更新 {specs, list}，正在重启…',
  noPackageJson:
    '读不到 {name} 的 package.json，无法确认它是什么，市场不卸；确认要卸就在项目目录执行 npm uninstall {name} 后重启',
  lifeline:
    '{name} 正在承载市场/管理界面本身，卸掉它这个页面会立刻不可用，只能在终端里恢复。若确要更换实现，请先装上替代者并在设置「系统」的服务偏好里切换过去，再回来卸载它。',
  originWorkspace: '它是工作区里的本地源码包，删除请走 git',
  originLink: '它由 file:/link: 指向本地目录，删除请改那份源码与依赖声明',
  originGit: '它由 git/URL/user-repo 简写安装，删除请改依赖声明',
  originAlias: '它由 npm: 别名指向另一个包，删除请改依赖声明',
  originTransitive: '它不在根依赖里（由其它插件带入），会随带入它的插件被 npm 自动剪枝',
  notFromMarket: '{name} 不是经市场安装的：{why}。',
  breaksDependents:
    '卸载会破坏依赖：{dependents, list} 依赖此插件提供的服务，且没有别的插件正在提供。请先停用它们，或启用 / 安装替代提供者。',
  uninstalledConfigUnsaved:
    '插件 {name} 已卸载（已从根依赖与 node_modules 移除），但配置文件没写成（{error}）：需要时手动删掉配置文件里它的配置段与停用标记。',
  uninstalledFlagUnsaved:
    '插件 {name} 已卸载（已从根依赖与 node_modules 移除），但配置文件没写成（{error}）：需要时手动删掉配置文件里它的停用标记。',
  uninstalledConfigRemoved:
    '插件 {name} 已卸载（已从根依赖与 node_modules 移除）。它的配置已从配置文件删除，只有它用的密钥一并删除；写在家目录 state/ 等处的数据不会删除，需要时请手动清理。',
  uninstalledConfigKept:
    '插件 {name} 已卸载（已从根依赖与 node_modules 移除）。它的配置留在配置文件里，重装后照原配置启动；写在家目录 state/ 等处的数据不会删除，需要时请手动清理。',
  kindCore: '内核',
  kindRuntime: '宿主',
  kindApi: '服务契约',
  kindSchema: '数据规范',
  kindUtil: '工具库',
  kindOther: '非插件包',
  installUnmarked:
    '{name} 是{kind}，不是可装卸的插件，市场不负责它的安装。市场只安装带 aalis-plugin / aalis-interface 关键词的包。',
  installBundled:
    '{name} 是{kind}，不是可装卸的插件，市场不负责它的安装。它随脚手架或依赖它的插件自动就位；要升级已装的版本，请在市场勾选它后用「更新所选」提交。',
  uninstallVital:
    '{name} 是{kind}，不是可装卸的插件，市场不负责它的卸载。删掉它实例将无法启动、市场也随之消失，只能在终端里恢复；确需如此请手动执行 npm uninstall。',
  uninstallPruned:
    '{name} 是{kind}，不是可装卸的插件，市场不负责它的卸载。它随依赖它的插件被 npm 自动剪枝；确需单独删除请手动执行 npm uninstall。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-package-manager',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

// 本插件自己的原文字典：不归市场装卸的包种类与装卸时的拒绝
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
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

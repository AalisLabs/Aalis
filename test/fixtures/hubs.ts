import type { App } from '../../packages/core/src/index.js';
import contributionsPlugin from '../../packages/plugin-contributions/src/index.js';
import hooksPlugin from '../../packages/plugin-hooks/src/index.js';

/**
 * 钩子与贡献点的默认提供者。core 不再内置它们：用到 hooks / contributions 的插件测试，
 * 与宿主一样先把这两个插件登记进去（嵌入式宿主放进同一批 pluginAll 即可）。
 */
export const HUB_PLUGINS = [hooksPlugin, contributionsPlugin];

/** 登记两个默认提供者并等激活落定 */
export async function registerHubs(app: App): Promise<void> {
  await app.pluginAll(HUB_PLUGINS.map(definition => ({ definition })));
  await app.plugins.idle();
}

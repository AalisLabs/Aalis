import { events } from '../../packages/api-events/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import contributionsPlugin from '../../packages/plugin-contributions/src/index.js';
import eventsPlugin, { Bus } from '../../packages/plugin-events/src/index.js';
import hooksPlugin from '../../packages/plugin-hooks/src/index.js';

/**
 * 事件、钩子与贡献点的默认提供者。core 不内置它们：用到 events / hooks / contributions 的插件测试，
 * 与宿主一样先把这三个插件登记进去（嵌入式宿主放进同一批 pluginAll 即可）。
 */
export const HUB_PLUGINS = [eventsPlugin, hooksPlugin, contributionsPlugin];

/** 登记三个默认提供者并等激活落定 */
export async function registerHubs(app: App): Promise<void> {
  await app.pluginAll(HUB_PLUGINS.map(definition => ({ definition })));
  await app.plugins.idle();
}

/**
 * 只用到事件、不用钩子与贡献点的用例：宿主根直接提供一条总线。同步，登记在根上，不占插件列表；
 * 监听器抛错记在 App 的日志器上。与 {@link registerHubs} 二选一
 */
export function provideEvents(app: App): void {
  app.bind({ provide }).provide.use(events, new Bus(app.logger));
}

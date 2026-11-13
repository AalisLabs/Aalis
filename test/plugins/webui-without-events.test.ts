import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import eventsPlugin from '../../packages/plugin-events/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 事件总线由一个普通插件提供，可以经管理页停用。提供管理页的插件不能随它下线：停用会写进配置，界面跟着下线的话
// 重启后照旧，只能手改配置文件救回。停用总线之后本插件照常在线、端口照常应答，总线回来后监听由归属表补挂。
// 界面语言插件同理：它下线的话管理页的文字全部退回原文。
// ════════════════════════════════════════════════════════════

describe('管理页不随事件总线下线', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  it('停用 plugin-events：本插件仍是 active，端口照常应答', async () => {
    const port = await freePort();
    const app = new App({ logLevel: 'error' });
    cleanups.push(() => app.stop());
    await registerHubs(app);
    await app.pluginAll([{ definition: webuiServerPlugin, config: { port, host: '127.0.0.1', autoOpen: false } }]);
    await app.start();
    await waitListening(port);

    expect(await app.plugins.disable(eventsPlugin.name)).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(webuiServerPlugin.name)?.state).toBe('active');
    expect((await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok).toBe(true);
  });

  it('停用 plugin-events：plugin-i18n 仍是 active', async () => {
    const app = new App({ logLevel: 'error' });
    cleanups.push(() => app.stop());
    await registerHubs(app);
    await app.pluginAll([{ definition: i18nPlugin }]);
    await app.start();

    expect(await app.plugins.disable(eventsPlugin.name)).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(i18nPlugin.name)?.state).toBe('active');
  });
});

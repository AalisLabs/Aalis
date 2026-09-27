import { afterEach, expect, it } from 'vitest';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { freePort } from '../helpers/net.js';

// /api/status 的 name 是对话对象的显示名，装有人设时是人设名（聊天用）；仪表盘的「应用名称」要看全局配置里的
// name，另由 appName 给出。只有 name 时，装了人设以后改应用名称在界面上看不出任何变化。

const TOKEN = 'zz-status-token-placeholder';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function status(withPersona: boolean): Promise<unknown> {
  const port = await freePort();
  const { app } = hostedApp({ name: 'N' }, { logger: silent });
  apps.push(app);
  if (withPersona) {
    app.bind({ provide }).provide(persona, { getPersonaName: () => 'P' } as unknown as PersonaService);
  }
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Cookie: `aalis_webui_token=${TOKEN}` },
      });
      return await res.json();
    } catch {
      await new Promise(r => setTimeout(r, 20)); // 还没开始监听
    }
  }
  throw new Error('WebUI 没有开始监听');
}

it('装有人设：name 是人设名，appName 是配置里的应用名称', async () => {
  expect(await status(true)).toMatchObject({ name: 'P', appName: 'N' });
});

it('没有人设：name 与 appName 都是应用名称', async () => {
  expect(await status(false)).toMatchObject({ name: 'N', appName: 'N' });
});

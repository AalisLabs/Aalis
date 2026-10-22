import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, type Logger } from '../../packages/core/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 宿主回答的可选项来源（/api/models/:service）：工具分组按一条规则列出，已登记的分组与工具上出现过的分组取并集，登记过的写
// 名字与概述，没登记的写原名，「*」总在最前、写「全部分组」，不带登记它的插件；没有字段用的 platform 来源不再由宿主回答。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-option-sources-token-placeholder';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 登记一个分组（带概述），另有两个工具：一个在登记过的分组里，一个在没登记的分组里 */
const owner = definePlugin({
  name: '@zz/option-sources',
  uses: { tools },
  apply({ tools }) {
    tools.use.registerGroup({ name: 'zz-web', label: '联网', summary: '搜索与抓取网页', description: '给模型的说明' });
    const tool = (name: string, groups: string[]) =>
      tools.use.register({
        definition: {
          type: 'function',
          function: { name, description: name, parameters: { type: 'object', properties: {} } },
        },
        handler: async () => '',
        groups,
      });
    tool('zz_fetch', ['zz-web']);
    tool('zz_history', ['zz-history']);
  },
});

async function get(path: string): Promise<unknown> {
  const port = await freePort();
  const { app } = hostedApp({ name: 'N' }, { logger: silent });
  apps.push(app);
  await app.plugin(toolsPlugin, {});
  await app.plugin(owner);
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie: `aalis_webui_token=${TOKEN}` } });
  return res.json();
}

describe('宿主回答的可选项来源', () => {
  it('工具分组：已登记的与工具上出现过的取并集，没登记的写原名，「*」写「全部分组」；不带登记它的插件', async () => {
    expect(await get('/api/models/toolGroups')).toEqual({
      models: ['*', 'zz-history', 'zz-web'],
      details: [
        { value: '*', label: '* （全部分组）' },
        { value: 'zz-history', label: 'zz-history' },
        { value: 'zz-web', label: '联网', description: '搜索与抓取网页' },
      ],
    });
  });

  it('platform 不再由宿主回答：按服务名合起各提供者的 listModels()，平台适配器没有它', async () => {
    expect(await get('/api/models/platform')).toEqual({ models: [] });
  });
});

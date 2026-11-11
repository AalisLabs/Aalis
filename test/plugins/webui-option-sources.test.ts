import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, type Logger } from '../../packages/core/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 宿主回答的可选项来源（/api/models/:service）：工具分组按一条规则列出，已登记的分组与工具上出现过的分组取并集，登记过的写
// 名字与概述，没登记的写原名，「*」总在最前、写「全部分组」、说明包括以后新装插件的分组、标明代表其余全部（all），
// 不带登记它的插件；有工具的分组带组内工具的名字（members，去重），不属于任何分组的工具另交 others；没有字段用的 platform
// 来源不再由宿主回答。插件经贡献点 webui:options 交的来源原样转交，可选项带的 members 照带。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-option-sources-token-placeholder';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/**
 * 登记两个分组（一个带概述，一个没有工具），另有四个工具：一个在登记过的分组里，一个在没登记的分组里，一个同时在两组里，
 * 一个把同一个分组写了两遍；另经 webui:options 交一个带成员的可选项来源
 */
const owner = definePlugin({
  name: '@zz/option-sources',
  uses: { tools, contributions },
  apply({ tools, contributions }) {
    tools.use.registerGroup({ name: 'zz-web', label: '联网', summary: '搜索与抓取网页', description: '给模型的说明' });
    tools.use.registerGroup({ name: 'zz-empty', label: '空组' });
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
    tool('zz_both', ['zz-web', 'zz-history']);
    tool('zz_twice', ['zz-web', 'zz-web']);
    contributions.use.contribute('webui:options', {
      id: 'zz-languages',
      list: () => [{ value: 'en', label: 'English', members: ['en-GB', 'en-US'] }],
    });
  },
});

async function get(path: string): Promise<unknown> {
  const port = await freePort();
  const { app } = hostedApp({ name: 'N' }, { logger: silent });
  apps.push(app);
  await registerHubs(app);
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
  it('工具分组：已登记的与工具上出现过的取并集，没登记的写原名，「*」写「全部分组」、带说明、标 all；有工具的分组带组内工具的名字（一个工具在几组就在每组都列，同一分组写了两遍的只列一次），「*」与没有工具的分组不带；没有无分组的工具时不交 others；不带登记它的插件', async () => {
    expect(await get('/api/models/toolGroups')).toEqual({
      models: ['*', 'zz-empty', 'zz-history', 'zz-web'],
      details: [
        { value: '*', label: '* （全部分组）', description: '包括以后新装插件的分组', all: true },
        { value: 'zz-empty', label: '空组' },
        { value: 'zz-history', label: 'zz-history', members: ['zz_both', 'zz_history'] },
        {
          value: 'zz-web',
          label: '联网',
          description: '搜索与抓取网页',
          members: ['zz_both', 'zz_fetch', 'zz_twice'],
        },
      ],
    });
  });

  it('插件经 webui:options 交的来源：可选项原样转交，带的 members 照带', async () => {
    expect(await get('/api/models/zz-languages')).toEqual({
      models: ['en'],
      details: [{ value: 'en', label: 'English', members: ['en-GB', 'en-US'] }],
    });
  });

  it('platform 不再由宿主回答：按服务名合并各提供者的 listModels()，平台适配器没有它', async () => {
    expect(await get('/api/models/platform')).toEqual({ models: [] });
  });
});

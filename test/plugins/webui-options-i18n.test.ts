import { afterEach, describe, expect, it } from 'vitest';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, type Logger, lifecycle, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { defineTexts } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, setHostLanguage } from '../fixtures/host-language.js';
import { provideEvents } from '../fixtures/hubs.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 的可选项接口按全局层的语言渲染产出方交来的文字对象：工具分组的名字与概述、不属于任何分组的工具那一行的名字
// （/api/models/toolGroups），深度思考档位的
// 名字（/api/models/llm-thinking 的可选项与 labels）。分组的 description 只给模型，不进可选项：没有概述的分组不显示概述。i18n 是真的 plugin-i18n，缺席时一律原文；全局语言
// 写在宿主配置文档里 plugin-i18n 的配置段。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-options-i18n-token-placeholder-0';
const OWNER = '@zz/options-i18n';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const t = defineTexts({
  ns: OWNER,
  language: 'zh-CN',
  source: { group: '翻译工具', summary: '把文字译成别的语言', off: '关', on: '开' } as const,
  locales: { en: { group: 'Translation tools', summary: 'Turns text into other languages', off: 'Off', on: 'On' } },
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/**
 * 登记两个工具分组（一个带概述、一个只有给模型的说明）、两个不属于任何分组的工具（按名字逆序登记，一个的分组是空数组）与
 * 一个能调思考的模型（档位名是文字对象）
 */
const owner = definePlugin({
  name: OWNER,
  uses: { tools, provide, lifecycle },
  apply({ tools, provide, lifecycle }) {
    tools.use.registerGroup({
      name: 'zz-translate',
      label: t('group'),
      summary: t('summary'),
      description: '给模型的长说明',
    });
    tools.use.registerGroup({ name: 'zz-bare', label: 'zz-bare', description: '只给模型的说明' });
    const tool = (name: string, groups?: string[]) =>
      tools.use.register({
        definition: {
          type: 'function',
          function: { name, description: name, parameters: { type: 'object', properties: {} } },
        },
        handler: async () => '',
        groups,
      });
    tool('zz_plain');
    tool('zz_nogroup', []);
    const model = {
      id: 'm1',
      providerId: lifecycle.use.id,
      contextLength: 8192,
      capabilities: ['chat'],
      chat: async () => ({ content: '' }),
      thinking: {
        levels: [
          { id: 'off', label: t('off') },
          { id: 'on', label: t('on') },
        ],
        default: 'on',
      },
    } as unknown as LLMModel;
    provide.use(llm, model, { entryId: `${lifecycle.use.id}/m1` });
  },
});

async function setup({ withI18n = true }: { withI18n?: boolean } = {}) {
  const port = await freePort();
  const { app } = hostedApp(i18nSection(['en']), { logger: silent });
  provideEvents(app);
  apps.push(app);
  const setLanguage = (language: string[]) => setHostLanguage(app, language);
  await app.plugin(toolsPlugin, {});
  if (withI18n) await app.plugin(i18nPlugin);
  await app.plugin(owner);
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie: `aalis_webui_token=${TOKEN}` } });
    return res.json();
  };
  /** 读者看到的：分组可选项（不含「全部分组」）与不属于任何分组的那一行、档位可选项与 labels */
  const shown = async () => {
    const groups = await get('/api/models/toolGroups');
    const dependency = encodeURIComponent(`${OWNER}/m1`);
    const thinking = await get(`/api/models/llm-thinking?dependency=${dependency}`);
    return {
      groups: groups.details.filter((detail: { value: string }) => detail.value !== '*'),
      others: groups.others,
      levels: thinking.details,
      labels: thinking.labels,
    };
  };
  return { shown, setLanguage };
}

const CHINESE = {
  groups: [
    { value: 'zz-bare', label: 'zz-bare' },
    { value: 'zz-translate', label: '翻译工具', description: '把文字译成别的语言' },
  ],
  others: { label: '不属于任何分组的工具', members: ['zz_nogroup', 'zz_plain'] },
  levels: [
    { value: 'off', label: '关' },
    { value: 'on', label: '开', default: true },
  ],
  labels: { off: '关', on: '开' },
};

const ENGLISH = {
  groups: [
    { value: 'zz-bare', label: 'zz-bare' },
    { value: 'zz-translate', label: 'Translation tools', description: 'Turns text into other languages' },
  ],
  others: { label: 'Tools outside any group', members: ['zz_nogroup', 'zz_plain'] },
  levels: [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On', default: true },
  ],
  labels: { off: 'Off', on: 'On' },
};

describe('可选项接口按全局层的语言渲染', () => {
  it('分组的名字与概述、不属于任何分组的那一行、档位名：en 拿英文，zh-CN 拿原文；没有概述的分组不显示概述', async () => {
    const { shown, setLanguage } = await setup();
    expect(await shown()).toEqual(ENGLISH);
    setLanguage(['zh-CN']);
    expect(await shown()).toEqual(CHINESE);
  });

  it('i18n 缺席时一律原文', async () => {
    const { shown } = await setup({ withI18n: false });
    expect(await shown()).toEqual(CHINESE);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, type Logger, lifecycle, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { defineTexts } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, setHostLanguage } from '../fixtures/host-language.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 的可选项接口按全局层的语言渲染产出方交来的文字对象：工具分组的名字与概述（/api/models/toolGroups），深度思考档位的
// 名字（/api/models/llm-thinking 的可选项与 labels），平台类型的显示名（/api/models/gateway-scopes，没有显示名的照旧写类型名）。
// 分组的 description 只给模型，不进可选项：没有概述的分组不显示概述。i18n 是真的 plugin-i18n，缺席时一律原文；全局语言
// 写在宿主配置文档里 plugin-i18n 的配置段。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-options-i18n-token-placeholder-0';
const OWNER = '@zz/options-i18n';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const t = defineTexts({
  ns: OWNER,
  language: 'zh-CN',
  source: { group: '翻译工具', summary: '把文字译成别的语言', off: '关', on: '开', room: '群聊' } as const,
  locales: {
    en: {
      group: 'Translation tools',
      summary: 'Turns text into other languages',
      off: 'Off',
      on: 'On',
      room: 'group chat',
    },
  },
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 登记两个工具分组（一个带概述、一个只有给模型的说明）、一个能调思考的模型（档位名是文字对象）与一个平台（一个类型有显示名） */
const owner = definePlugin({
  name: OWNER,
  uses: { tools, provide, lifecycle },
  apply({ tools, provide, lifecycle }) {
    provide.use(platform, {
      adapterName: 'zz',
      platform: 'zz',
      sessionTypes: [
        { name: 'room', multiParty: true, label: t('room') },
        { name: 'dm', multiParty: false },
      ],
      getConnections: () => [],
      sendMessage: async () => {},
    } satisfies PlatformAdapter);
    tools.use.registerGroup({
      name: 'zz-translate',
      label: t('group'),
      summary: t('summary'),
      description: '给模型的长说明',
    });
    tools.use.registerGroup({ name: 'zz-bare', label: 'zz-bare', description: '只给模型的说明' });
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
  /** 读者看到的：分组可选项（不含「全部分组」）、档位可选项与 labels、作用域可选项里与平台类型有关的几项 */
  const shown = async () => {
    const groups = await get('/api/models/toolGroups');
    const dependency = encodeURIComponent(`${OWNER}/m1`);
    const thinking = await get(`/api/models/llm-thinking?dependency=${dependency}`);
    const scopes = await get('/api/models/gateway-scopes');
    return {
      groups: groups.details.filter((detail: { value: string }) => detail.value !== '*'),
      levels: thinking.details,
      labels: thinking.labels,
      scopes: scopes.details.filter((detail: { value: string }) => /^(\*:|zz:)(room|dm)$/.test(detail.value)),
    };
  };
  return { shown, setLanguage };
}

const CHINESE = {
  groups: [
    { value: 'zz-bare', label: 'zz-bare' },
    { value: 'zz-translate', label: '翻译工具', description: '把文字译成别的语言' },
  ],
  levels: [
    { value: 'off', label: '关' },
    { value: 'on', label: '开', default: true },
  ],
  labels: { off: '关', on: '开' },
  scopes: [
    { value: '*:dm', label: '*:dm （所有平台的 dm 会话）' },
    { value: '*:room', label: '*:room （所有平台的 群聊 会话）' },
    { value: 'zz:room', label: 'zz:room （群聊）' },
    { value: 'zz:dm', label: 'zz:dm' },
  ],
};

const ENGLISH = {
  groups: [
    { value: 'zz-bare', label: 'zz-bare' },
    { value: 'zz-translate', label: 'Translation tools', description: 'Turns text into other languages' },
  ],
  levels: [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On', default: true },
  ],
  labels: { off: 'Off', on: 'On' },
  scopes: [
    { value: '*:dm', label: '*:dm (dm sessions on every platform)' },
    { value: '*:room', label: '*:room (group chat sessions on every platform)' },
    { value: 'zz:room', label: 'zz:room (group chat)' },
    { value: 'zz:dm', label: 'zz:dm' },
  ],
};

describe('可选项接口按全局层的语言渲染', () => {
  it('分组的名字与概述、档位名、平台类型的显示名：en 拿英文，zh-CN 拿原文；没有概述的分组不显示概述，没有显示名的类型写类型名', async () => {
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

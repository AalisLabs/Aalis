import { afterEach, describe, expect, it } from 'vitest';
import type {} from '../../packages/api-agent/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import toolSearch from '../../packages/plugin-tool-search/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { defineTexts } from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { toolRequest } from '../fixtures/tool-call.js';

const t = defineTexts({
  ns: '@zz/tool-search-catalog',
  language: 'zh-CN',
  source: { label: '翻译工具' } as const,
  locales: { en: { label: 'Translation tools' } },
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function world(showToolNames = true, firstGroupTools = 0, maxSearchResults = 10) {
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(toolsPlugin);
  await app.plugin(toolSearch, { maxDirectTools: 1, showToolNames, maxSearchResults });
  await app.plugins.idle();
  const host = app.bind({ hooks, tools });
  const service = host.tools.use;
  if (firstGroupTools > 0) {
    service.registerGroup({ name: 'bulk', label: '庞大操作集', description: '包含许多不相干的后台操作' });
    for (let i = 0; i < firstGroupTools; i++) {
      service.register({
        groups: ['bulk'],
        definition: {
          type: 'function',
          function: {
            name: `bulk_operation_${String(i).padStart(3, '0')}`,
            description: '后台操作',
            parameters: { type: 'object', properties: {} },
          },
        },
        handler: async () => '{}',
      });
    }
  }
  service.registerGroup({ name: 'canvas', label: '画布创作', description: '按需求制作网页、图像和动画' });
  service.registerGroup({ name: 'billing', label: '账单结算', description: '核对并结清待付账单' });
  service.registerGroup({ name: 'secret', label: '私密管理', description: '处理受限资料' });
  for (const [name, description, groups] of [
    ['read_note', '读取 canvas_task 指令笔记', ['canvas']],
    ['canvas_status', '查看任务状态', ['canvas']],
    ['canvas_task', '提交制作任务', ['canvas']],
    ['billing_settle', '结清账单', ['billing']],
    ['bridge', '两组共用的工具', ['canvas', 'secret']],
    ['helper', '通用帮助', []],
  ] as const) {
    service.register({
      groups: [...groups],
      definition: {
        type: 'function',
        function: { name, description, parameters: { type: 'object', properties: {} } },
      },
      handler: async () => '{}',
    });
  }
  async function visible(groups: string[]) {
    const data: HookContextMap['agent:llm:before'] = {
      messages: [],
      tools: service.getDefinitions({ groups }),
      acceptsImages: false,
      sessionId: 'room-1',
    };
    await host.hooks.use.run('agent:llm:before', data, async () => {});
    return data.tools;
  }
  async function search(query: string, groups: string[], options: { limit?: number; offset?: number } = {}) {
    const response = await service.execute(
      'search_tools',
      { query, ...options },
      toolRequest({ sessionId: 'room-1', enabledGroups: groups }),
    );
    return JSON.parse(response.content) as Record<string, unknown> & {
      tools: Array<{ name: string }>;
      found: number;
      hint: string;
    };
  }
  return { visible, search, service };
}

describe('search_tools 可用能力目录', () => {
  it('只概括本轮已启用分组，组描述和组内工具名帮助发现能力，禁用组不泄漏', async () => {
    const h = await world();
    const definitions = await h.visible(['canvas']);
    const catalog = definitions[0].function.description;
    expect(catalog).toContain('画布创作');
    expect(catalog).toContain('制作网页、图像和动画');
    expect(catalog).toContain('canvas_task');
    expect(catalog).not.toContain('账单结算');
    expect(catalog).not.toContain('billing_settle');
    expect(catalog).not.toContain('私密管理');
    expect((await h.search('画布创作', ['canvas'])).tools.map(tool => tool.name)).toContain('canvas_task');
    expect((await h.search('账单结算', ['canvas'])).tools).toEqual([]);
    expect((await h.search('私密管理', ['canvas'])).tools).toEqual([]);
  });

  it('分组名是文字对象：目录与搜索按它的原文', async () => {
    const h = await world();
    h.service.registerGroup({ name: 'translate', label: t('label'), description: '把文字译成别的语言' });
    h.service.register({
      groups: ['translate'],
      definition: {
        type: 'function',
        function: { name: 'translate_text', description: '翻译', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => '{}',
    });
    const catalog = (await h.visible(['translate']))[0].function.description;
    expect(catalog).toContain('- 翻译工具（translate）：');
    expect((await h.search('翻译工具', ['translate'])).tools.map(tool => tool.name)).toEqual(['translate_text']);
  });

  it('名称精确和前缀优先，同分结果保持注册顺序', async () => {
    const h = await world();
    expect((await h.search('canvas_task', ['canvas'])).tools.map(tool => tool.name)[0]).toBe('canvas_task');
    expect((await h.search('canvas', ['canvas'])).tools.map(tool => tool.name).slice(0, 2)).toEqual([
      'canvas_status',
      'canvas_task',
    ]);
  });

  it('各关键词的得分相加，工具自己的说明压过同组共用的分组说明', async () => {
    const h = await world();
    h.service.registerGroup({ name: 'onebot-admin', label: 'OneBot 群管', description: '禁言、踢人等群管理操作' });
    h.service.registerGroup({
      name: 'onebot-daily',
      label: 'OneBot 只读与日常',
      description: '查群信息、戳一戳、好友赞',
    });
    for (const [name, description, group] of [
      ['onebot_group_ban', '禁言群成员', 'onebot-admin'],
      ['onebot_group_kick', '把成员踢出群', 'onebot-admin'],
      ['onebot_get_group_info', '查群信息', 'onebot-daily'],
      ['onebot_get_member_info', '查群成员信息', 'onebot-daily'],
      ['onebot_poke', '戳一戳群成员或好友', 'onebot-daily'],
    ] as const) {
      h.service.register({
        groups: [group],
        definition: {
          type: 'function',
          function: { name, description, parameters: { type: 'object', properties: {} } },
        },
        handler: async () => '{}',
      });
    }
    const groups = ['onebot-admin', 'onebot-daily'];
    expect((await h.search('onebot 戳一戳', groups)).tools[0]?.name).toBe('onebot_poke');
    expect((await h.search('戳一戳', groups)).tools[0]?.name).toBe('onebot_poke');
  });

  it('found 是匹配总数；有下一页时 hint 先说还有几个、怎么翻，offset 超出匹配数时照实说', async () => {
    const h = await world(true, 23, 10);
    const first = await h.search('bulk_operation', ['bulk']);
    expect(first.found).toBe(23);
    expect(first).not.toHaveProperty('pagination');
    expect(first.hint).toContain('offset=10');
    expect(first.hint).not.toContain('无需再次搜索');
    const beyond = await h.search('bulk_operation', ['bulk'], { offset: 40 });
    expect(beyond.found).toBe(23);
    expect(beyond.tools).toEqual([]);
    expect(beyond.hint).not.toContain('未找到匹配的工具');
    expect(beyond.hint).toContain('offset 超出匹配数 23');
  });

  it('showToolNames 关闭时不注入能力目录，搜索仍按分组可用', async () => {
    const h = await world(false);
    const catalog = (await h.visible(['canvas']))[0].function.description;
    expect(catalog).not.toContain('画布创作');
    expect(catalog).not.toContain('canvas_task');
    expect((await h.search('画布创作', ['canvas'])).tools.map(tool => tool.name)).toContain('canvas_task');
  });

  it('大量组说明受固定长度预算约束', async () => {
    const h = await world();
    const enabled = ['canvas'];
    for (let i = 0; i < 80; i++) {
      const group = `group_${i}`;
      enabled.push(group);
      h.service.registerGroup({ name: group, label: `能力${i}`, description: '说明'.repeat(100) });
      h.service.register({
        groups: [group],
        definition: {
          type: 'function',
          function: { name: `tool_${i}`, description: '测试', parameters: { type: 'object', properties: {} } },
        },
        handler: async () => '{}',
      });
    }
    const catalog = (await h.visible(enabled))[0].function.description;
    expect(catalog.length).toBeLessThan(4000);
    expect(catalog).toContain('更多');
  });

  it('前组有 200 个工具时，有限目录仍保留后组能力和工具示例', async () => {
    const h = await world(true, 200);
    const catalog = (await h.visible(['bulk', 'canvas']))[0].function.description;
    expect(catalog.length).toBeLessThan(4000);
    expect(catalog).toContain('庞大操作集');
    expect(catalog).toContain('画布创作');
    expect(catalog).toContain('制作网页、图像和动画');
    expect(catalog).toContain('canvas_task');
    expect(catalog).not.toContain('账单结算');
    expect(catalog).not.toContain('billing_settle');
  });

  it('模型请求过大仍受宿主单次上限约束，较小 limit 与分页不漏结果', async () => {
    const h = await world(true, 23, 10);
    const oversized = await h.search('bulk_operation', ['bulk'], { limit: 10000 });
    expect(oversized.tools).toHaveLength(10);
    expect(oversized.found).toBe(23);
    expect(oversized.hint).toContain('还有 13 个没给：用 offset=10 查看下一页');
    const names: string[] = [];
    for (let offset = 0; offset < 23; offset += 4) {
      const page = await h.search('bulk_operation', ['bulk'], { limit: 4, offset });
      expect(page.tools.length).toBeLessThanOrEqual(4);
      names.push(...page.tools.map(tool => tool.name));
    }
    expect(names).toEqual(Array.from({ length: 23 }, (_, i) => `bulk_operation_${String(i).padStart(3, '0')}`));
  });

  it('非有限及非正 limit 用宿主默认值，正小数至少返回一项；宿主上限 0 可主动放宽', async () => {
    const bounded = await world(true, 23, 10);
    for (const limit of [Number.POSITIVE_INFINITY, Number.NaN, 0, -3]) {
      expect((await bounded.search('bulk_operation', ['bulk'], { limit })).tools).toHaveLength(10);
    }
    expect((await bounded.search('bulk_operation', ['bulk'], { limit: 0.5 })).tools).toHaveLength(1);
    const unlimited = await world(true, 23, 0);
    expect((await unlimited.search('bulk_operation', ['bulk'], { limit: 20 })).tools).toHaveLength(20);
    expect((await unlimited.search('bulk_operation', ['bulk'])).tools).toHaveLength(23);
  });

  it('宿主上限配置拒绝负数与小数，回落默认 5', async () => {
    for (const configured of [-1, 2.5]) {
      const h = await world(true, 23, configured);
      expect((await h.search('bulk_operation', ['bulk'], { limit: 10000 })).tools).toHaveLength(5);
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import type {} from '../../packages/api-agent/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import toolSearch from '../../packages/plugin-tool-search/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function world(showToolNames = true, firstGroupTools = 0, maxSearchResults = 10) {
  const app = new App({ name: 'tool-search-catalog', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(toolsPlugin);
  await app.plugin(toolSearch, { maxDirectTools: 1, showToolNames, maxSearchResults });
  await app.plugins.idle();
  const host = app.bind({ hooks, tools });
  const service = host.tools.require();
  if (firstGroupTools > 0) {
    service.registerGroup({ name: 'bulk', label: '庞大操作集', description: '包含许多不相干的后台操作' }, 'fixture');
    for (let i = 0; i < firstGroupTools; i++) {
      service.register(
        {
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
        },
        'fixture',
      );
    }
  }
  service.registerGroup(
    { name: 'paper', label: '白纸创作', description: '把需求交给代理制作网页、图像和动画' },
    'fixture',
  );
  service.registerGroup({ name: 'works', label: '作品发布', description: '把成品提名审核并公开展示' }, 'fixture');
  service.registerGroup({ name: 'secret', label: '私密管理', description: '处理受限资料' }, 'fixture');
  for (const [name, description, groups] of [
    ['read_note', '读取 paper_task 指令笔记', ['paper']],
    ['paper_status', '查看任务状态', ['paper']],
    ['paper_task', '提交制作任务', ['paper']],
    ['works_nominate', '提名作品', ['works']],
    ['bridge', '两组共用的工具', ['paper', 'secret']],
    ['helper', '通用帮助', []],
  ] as const) {
    service.register(
      {
        groups: [...groups],
        definition: {
          type: 'function',
          function: { name, description, parameters: { type: 'object', properties: {} } },
        },
        handler: async () => '{}',
      },
      'fixture',
    );
  }
  async function visible(groups: string[]) {
    const data: HookContextMap['agent:llm:before'] = {
      messages: [],
      tools: service.getDefinitions({ groups }),
      sessionId: 'room-1',
    };
    await host.hooks.run('agent:llm:before', data, async () => {});
    return data.tools;
  }
  async function search(query: string, groups: string[], options: { limit?: number; offset?: number } = {}) {
    const response = await service.execute(
      'search_tools',
      { query, ...options },
      { sessionId: 'room-1', enabledGroups: groups },
    );
    return JSON.parse(response.content) as {
      tools: Array<{ name: string }>;
      found: string;
      pagination?: { total: number; offset: number; returned: number; nextOffset?: number };
    };
  }
  return { visible, search, service };
}

describe('search_tools 可用能力目录', () => {
  it('只概括本轮已启用分组，组描述和组内工具名帮助发现能力，禁用组不泄漏', async () => {
    const h = await world();
    const definitions = await h.visible(['paper']);
    const catalog = definitions[0].function.description;
    expect(catalog).toContain('白纸创作');
    expect(catalog).toContain('制作网页、图像和动画');
    expect(catalog).toContain('paper_task');
    expect(catalog).not.toContain('作品发布');
    expect(catalog).not.toContain('works_nominate');
    expect(catalog).not.toContain('私密管理');
    expect((await h.search('白纸创作', ['paper'])).tools.map(tool => tool.name)).toContain('paper_task');
    expect((await h.search('作品发布', ['paper'])).tools).toEqual([]);
    expect((await h.search('私密管理', ['paper'])).tools).toEqual([]);
  });

  it('名称精确和前缀优先，同分结果保持注册顺序', async () => {
    const h = await world();
    expect((await h.search('paper_task', ['paper'])).tools.map(tool => tool.name)[0]).toBe('paper_task');
    expect((await h.search('paper', ['paper'])).tools.map(tool => tool.name).slice(0, 2)).toEqual([
      'paper_status',
      'paper_task',
    ]);
  });

  it('showToolNames 关闭时不注入能力目录，搜索仍按分组可用', async () => {
    const h = await world(false);
    const catalog = (await h.visible(['paper']))[0].function.description;
    expect(catalog).not.toContain('白纸创作');
    expect(catalog).not.toContain('paper_task');
    expect((await h.search('白纸创作', ['paper'])).tools.map(tool => tool.name)).toContain('paper_task');
  });

  it('大量组说明受固定长度预算约束', async () => {
    const h = await world();
    const enabled = ['paper'];
    for (let i = 0; i < 80; i++) {
      const group = `group_${i}`;
      enabled.push(group);
      h.service.registerGroup({ name: group, label: `能力${i}`, description: '说明'.repeat(100) }, 'fixture');
      h.service.register(
        {
          groups: [group],
          definition: {
            type: 'function',
            function: { name: `tool_${i}`, description: '测试', parameters: { type: 'object', properties: {} } },
          },
          handler: async () => '{}',
        },
        'fixture',
      );
    }
    const catalog = (await h.visible(enabled))[0].function.description;
    expect(catalog.length).toBeLessThan(4000);
    expect(catalog).toContain('更多');
  });

  it('前组有 200 个工具时，有限目录仍保留后组能力和工具示例', async () => {
    const h = await world(true, 200);
    const catalog = (await h.visible(['bulk', 'paper']))[0].function.description;
    expect(catalog.length).toBeLessThan(4000);
    expect(catalog).toContain('庞大操作集');
    expect(catalog).toContain('白纸创作');
    expect(catalog).toContain('制作网页、图像和动画');
    expect(catalog).toContain('paper_task');
    expect(catalog).not.toContain('作品发布');
    expect(catalog).not.toContain('works_nominate');
  });

  it('模型请求过大仍受宿主单次上限约束，较小 limit 与分页不漏结果', async () => {
    const h = await world(true, 23, 10);
    const oversized = await h.search('bulk_operation', ['bulk'], { limit: 10000 });
    expect(oversized.tools).toHaveLength(10);
    expect(oversized.pagination).toMatchObject({ total: 23, offset: 0, returned: 10, nextOffset: 10 });
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

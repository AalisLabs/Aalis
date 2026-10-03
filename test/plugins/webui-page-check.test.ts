import { describe, expect, it } from 'vitest';
import { MAX_PAGE_TABS, MAX_SCREEN_COMPONENTS } from '../../packages/api-webui/src/index.js';
import { checkNotice, checkPage } from '../../packages/plugin-webui-server/src/page-check.js';

// ════════════════════════════════════════════════════════════
// 页面登记时的质量门槛：嵌套最多一层、一屏最多 6 个组件、最多 6 个标签、组件 id 唯一、引用的动作存在且放对了地方，
// 不认识的字段（含旧写法的 refresh、danger、source、searchable 与内联 SVG 图标）一律拒收。
// 页面经真实 webui-server 登记被拒时记错误日志、不出现在页面表里，见 webui-pages.test.ts。
// ════════════════════════════════════════════════════════════

const md = (id: string) => ({ type: 'markdown', id, data: () => '' });
const table = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'table',
  id,
  rowKey: 'id',
  columns: [{ key: 'id', label: '编号', primary: true }],
  data: () => [],
  ...extra,
});
const act = (extra: Record<string, unknown> = {}) => ({ label: '运行', effect: 'write', handler: () => {}, ...extra });

/** 没过时的问题清单 */
function problems(page: Record<string, unknown>): string[] {
  const result = checkPage({ key: 'p', title: '页面', ...page });
  return result.ok ? [] : result.problems;
}

describe('页面登记的质量门槛', () => {
  it('合格的页面通过：标签页、带详情的表格、行动作与页面动作、会话面板的 applies', () => {
    const result = checkPage({
      key: 'paper',
      title: '白纸',
      icon: 'file-text',
      order: 1,
      actions: {
        cancel: act({ row: true, effect: 'destructive', confirm: '取消这个任务？' }),
        create: act({ input: { name: { type: 'string', label: '名字', required: true } } }),
      },
      content: {
        tabs: [
          {
            key: 'papers',
            title: '白纸',
            content: [
              table('papers', {
                rowActions: [{ action: 'cancel', visibleWhen: 'running' }],
                detail: [md('ledger'), { type: 'actions', actions: ['cancel'] }],
              }),
              { type: 'actions', actions: ['create'] },
            ],
          },
          {
            key: 'graph',
            title: '关系',
            content: [
              {
                type: 'graph',
                id: 'g',
                nodeKinds: [{ kind: 'person', label: '人物', tone: 1 }],
                spacing: 120,
                data: () => ({ nodes: [], edges: [] }),
                detail: [{ type: 'info', id: 'node', data: () => [] }],
              },
            ],
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.placement).toBe('plugin');
    expect([...result.page.sources].map(([id, s]) => [id, s.inDetail])).toEqual([
      ['papers', false],
      ['ledger', true],
      ['g', false],
      ['node', true],
    ]);
    expect([...result.page.actions.keys()]).toEqual(['cancel', 'create']);
    expect(
      checkPage({ key: 'panel', title: '面板', placement: 'session', applies: () => true, content: [md('a')] }).ok,
    ).toBe(true);
  });

  it('标签页里再套标签页被拒', () => {
    expect(problems({ content: { tabs: [{ key: 'a', title: 'A', content: { tabs: [] } }] } })).toEqual([
      'content.tabs[0].content：要是非空的组件数组',
    ]);
    expect(problems({ content: { tabs: [{ key: 'a', title: 'A', content: [{ type: 'tabs', items: [] }] }] } })).toEqual(
      ['content.tabs[0].content[0].type：不认识的组件 tabs（只有 table、graph、info、markdown、actions）'],
    );
  });

  it('详情里的组件再带详情被拒', () => {
    expect(problems({ content: [table('a', { detail: [table('b', { detail: [md('c')] })] })] })).toEqual([
      'content[0].detail[0].detail：详情里的组件不能再带详情',
    ]);
  });

  it(`一屏超过 ${MAX_SCREEN_COMPONENTS} 个组件被拒：最外层、标签与详情各算一屏`, () => {
    const seven = (prefix: string) => Array.from({ length: MAX_SCREEN_COMPONENTS + 1 }, (_, i) => md(`${prefix}${i}`));
    expect(problems({ content: seven('a') })).toEqual([`content：一屏最多 ${MAX_SCREEN_COMPONENTS} 个组件，现在 7 个`]);
    expect(problems({ content: { tabs: [{ key: 't', title: 'T', content: seven('b') }] } })).toEqual([
      `content.tabs[0].content：一屏最多 ${MAX_SCREEN_COMPONENTS} 个组件，现在 7 个`,
    ]);
    expect(problems({ content: [table('t', { detail: seven('c') })] })).toEqual([
      `content[0].detail：一屏最多 ${MAX_SCREEN_COMPONENTS} 个组件，现在 7 个`,
    ]);
    expect(problems({ content: Array.from({ length: MAX_SCREEN_COMPONENTS }, (_, i) => md(`d${i}`)) })).toEqual([]);
  });

  it(`超过 ${MAX_PAGE_TABS} 个标签被拒`, () => {
    const tabs = Array.from({ length: MAX_PAGE_TABS + 1 }, (_, i) => ({
      key: `t${i}`,
      title: `T${i}`,
      content: [md(`m${i}`)],
    }));
    expect(problems({ content: { tabs } })).toEqual([`content.tabs：要有 1 到 ${MAX_PAGE_TABS} 个标签，现在 7 个`]);
  });

  it('引用的动作要存在，行动作只放在行上与详情里，页面动作只放在最外层与标签里', () => {
    expect(problems({ content: [{ type: 'actions', actions: ['nope'] }] })).toEqual([
      'content[0].actions[0]：引用的动作 nope 没有声明',
    ]);
    expect(
      problems({ actions: { cancel: act({ row: true }) }, content: [{ type: 'actions', actions: ['cancel'] }] }),
    ).toEqual(['content[0].actions[0]：cancel 是行动作，只能放在表格行上或详情里']);
    expect(
      problems({ actions: { create: act() }, content: [table('t', { rowActions: [{ action: 'create' }] })] }),
    ).toEqual(['content[0].rowActions[0].action：create 不是行动作（row: true），不能放在表格行上或详情里']);
    expect(
      problems({
        actions: { create: act() },
        content: [table('t', { detail: [{ type: 'actions', actions: ['create'] }] })],
      }),
    ).toEqual(['content[0].detail[0].actions[0]：create 不是行动作（row: true），不能放在表格行上或详情里']);
  });

  it('组件 id 在页面内唯一，跨标签与详情也算', () => {
    expect(
      problems({
        content: {
          tabs: [
            { key: 'a', title: 'A', content: [table('x', { detail: [md('y')] })] },
            { key: 'b', title: 'B', content: [md('y')] },
          ],
        },
      }),
    ).toEqual(['content.tabs[1].content[0].id：组件 id y 重复']);
  });

  it('旧写法一律拒收：refresh、danger、source、searchable、stat 与 form 组件、内联 SVG 图标、列上的 method', () => {
    expect(
      problems({
        icon: '<svg viewBox="0 0 24 24"></svg>',
        refresh: 30,
        actions: { del: act({ danger: true }) },
        content: [
          table('t', {
            searchable: true,
            refresh: 5,
            columns: [{ key: 'f', label: '文件', kind: 'file', method: 'read' }],
          }),
          { type: 'stat', label: '数', source: 'count' },
          { type: 'form', source: 'get', save: 'set', schema: {} },
        ],
      }),
    ).toEqual([
      'refresh：不认识的字段',
      'icon：只收 lucide 图标名（小写字母、数字与连字符）',
      'actions.del.danger：不认识的字段',
      'content[0].searchable：不认识的字段',
      'content[0].refresh：不认识的字段',
      'content[0].columns[0].method：不认识的字段',
      'content[1].type：不认识的组件 stat（只有 table、graph、info、markdown、actions）',
      'content[2].type：不认识的组件 form（只有 table、graph、info、markdown、actions）',
    ]);
  });

  it('applies 只给会话面板，确认文案只给 destructive 且不能为空，关系图的分类色只有 1 到 6', () => {
    expect(problems({ applies: () => true, content: [md('a')] })).toEqual([
      'applies：只给会话面板（placement 为 session）',
    ]);
    expect(
      problems({ actions: { go: act({ confirm: '确定？' }) }, content: [{ type: 'actions', actions: ['go'] }] }),
    ).toEqual(['actions.go.confirm：确认文案只给 destructive 的动作']);
    expect(
      problems({
        actions: { go: act({ effect: 'destructive', confirm: '' }) },
        content: [{ type: 'actions', actions: ['go'] }],
      }),
      '空的确认文案会把宿主默认的警示也去掉',
    ).toEqual(['actions.go.confirm：要是非空字符串']);
    expect(
      problems({
        content: [
          {
            type: 'graph',
            id: 'g',
            edgeKinds: [{ kind: 'k', label: 'K', tone: 7 }],
            data: () => ({ nodes: [], edges: [] }),
          },
        ],
      }),
    ).toEqual(['content[0].edgeKinds[0].tone：只有 1 到 6']);
  });
});

describe('提示登记时的校验', () => {
  const placements: Record<string, 'plugin' | 'settings' | 'session'> = {
    works: 'plugin',
    authority: 'settings',
    files: 'session',
  };
  const placementOf = (pageKey: string) => placements[pageKey];

  it('open 只收 config 与本插件位置为 plugin 或 settings 的页面', () => {
    const base = { id: 'n', level: 'action', title: '3 件作品待裁决' };
    expect(checkNotice({ ...base, open: 'config' }, placementOf)).toEqual([]);
    expect(checkNotice({ ...base, open: { page: 'works' } }, placementOf)).toEqual([]);
    expect(checkNotice({ ...base, open: { page: 'authority' } }, placementOf)).toEqual([]);
    const refused = ['open：只收 config，或本插件已登记、位置为 plugin 或 settings 的页面 { page }'];
    expect(checkNotice({ ...base, open: { page: 'files' } }, placementOf), '会话面板的页面打不开').toEqual(refused);
    expect(
      checkNotice({ ...base, open: { page: 'elsewhere' } }, placementOf),
      '别的插件的页面不在本插件的表里',
    ).toEqual(refused);
  });

  it('级别只有 action 与 error，不认识的字段拒收', () => {
    expect(checkNotice({ id: 'n', level: 'warning', title: 't', count: 3 }, placementOf)).toEqual([
      'count：不认识的字段',
      'level：只有 action、error',
    ]);
  });
});

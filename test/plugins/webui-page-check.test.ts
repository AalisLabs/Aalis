import { describe, expect, it } from 'vitest';
import { FRAME_NAME_MAX_LENGTH, MAX_PAGE_TABS, MAX_SCREEN_COMPONENTS } from '../../packages/api-webui/src/index.js';
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
    if (!result.ok || result.page.kind !== 'declarative') throw new Error('应当登记成声明式页面');
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

describe('插件前端页面登记时的校验', () => {
  const MODULE = 'file:///zz/frame-owner/dist/index.js';
  const field = { id: { type: 'string', label: '卡片', required: true } };

  it('合格的插件前端页面通过：入口与能力有默认，数据源带或不带输入，动作照声明式的写法', () => {
    const result = checkPage({
      key: 'board',
      title: '看板',
      placement: 'session',
      applies: () => true,
      frame: { module: MODULE, entry: 'app/main.html', host: ['sessions:read', 'turn:abort'] },
      sources: { cards: { data: () => [] }, card: { input: field, data: () => ({}) } },
      actions: { archive: act({ effect: 'destructive', confirm: '归档后不能恢复', input: field }) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.page.kind !== 'frame') throw new Error('应当登记成插件前端页面');
    expect(result.page.placement).toBe('session');
    expect(result.page.frame).toEqual({
      module: MODULE,
      entry: 'app/main.html',
      host: ['sessions:read', 'turn:abort'],
    });
    expect([...result.page.sources].map(([name, source]) => [name, source.input])).toEqual([
      ['cards', undefined],
      ['card', field],
    ]);
    expect([...result.page.actions.keys()]).toEqual(['archive']);

    const plain = checkPage({ key: 'p', title: '页面', frame: { module: MODULE } });
    if (!plain.ok || plain.page.kind !== 'frame') throw new Error('应当登记成插件前端页面');
    expect(plain.page.placement).toBe('plugin');
    expect(plain.page.frame).toEqual({ module: MODULE, entry: 'index.html', host: [] });
  });

  it('content 与 frame 恰好写一个', () => {
    const exactlyOne = ['content：与 frame 恰好写一个（声明式页面写 content，插件前端写 frame）'];
    expect(problems({ frame: { module: MODULE }, content: [md('a')] })).toEqual(exactlyOne);
    expect(problems({})).toEqual(exactlyOne);
  });

  it('frame 只认 module、entry、host；module 要是字符串；entry 只许 webui/ 里的 .html 相对路径', () => {
    expect(problems({ frame: 'index.html' })).toEqual(['frame：要是对象']);
    expect(problems({ frame: { module: MODULE, dir: 'public' } })).toEqual(['frame.dir：不认识的字段']);
    expect(problems({ frame: { entry: 'index.html' } })).toEqual([
      'frame.module：要是非空字符串（写 import.meta.url）',
    ]);
    const badEntry =
      'frame.entry：只许 webui/ 里以 .html 结尾的相对路径：不以 / 开头，各段非空、不以点开头，不含反斜杠';
    for (const entry of [
      'index.htm',
      'main.js',
      '/index.html',
      '../index.html',
      'a/../../index.html',
      './index.html',
      'a//index.html',
      '.hidden/index.html',
      'a\\..\\index.html',
      '',
      7,
    ]) {
      expect(problems({ frame: { module: MODULE, entry } }), String(entry)).toEqual([badEntry]);
    }
  });

  it('位置只有 plugin 与 session，applies 只给 session', () => {
    expect(problems({ placement: 'settings', frame: { module: MODULE } })).toEqual([
      'placement：插件前端只放在 plugin 或 session',
    ]);
    expect(problems({ applies: () => true, frame: { module: MODULE } })).toEqual([
      'applies：只给会话面板（placement 为 session）',
    ]);
  });

  it('host 只收词表里的能力，不重复', () => {
    expect(problems({ frame: { module: MODULE, host: 'sessions:read' } })).toEqual(['frame.host：要是数组']);
    expect(problems({ frame: { module: MODULE, host: null } })).toEqual(['frame.host：要是数组']);
    expect(problems({ frame: { module: MODULE, host: ['sessions:read', 'approvals:respond'] } })).toEqual([
      'frame.host[1]：不认识的能力 approvals:respond（只有 sessions:read、turn:abort）',
    ]);
    expect(problems({ frame: { module: MODULE, host: ['turn:abort', 'turn:abort'] } })).toEqual([
      'frame.host[1]：能力 turn:abort 重复',
    ]);
  });

  it('sources 只给插件前端：名字非空，各有 data 函数，input 是合法的字段表，不认识的字段拒收', () => {
    expect(problems({ content: [md('a')], sources: { x: { data: () => 1 } } })).toEqual([
      'sources：只给插件前端（写了 frame 的页面）',
    ]);
    const frame = { module: MODULE };
    expect(problems({ frame, sources: [] })).toEqual(['sources：要是对象']);
    expect(problems({ frame, sources: { ' ': { data: () => 1 } } })).toEqual(['sources：数据源的名字要非空']);
    expect(problems({ frame, sources: { x: () => 1 } })).toEqual(['sources.x：要是对象']);
    expect(problems({ frame, sources: { x: { data: 1 } } })).toEqual(['sources.x.data：要是函数']);
    expect(problems({ frame, sources: { x: { data: () => 1, refresh: 5 } } })).toEqual([
      'sources.x.refresh：不认识的字段',
    ]);
    expect(problems({ frame, sources: { x: { data: () => 1, input: {} } } })).toEqual([
      'sources.x.input：要是非空的字段表',
    ]);
    expect(problems({ frame, sources: { x: { data: () => 1, input: { id: { type: 'string' } } } } })).toEqual([
      'sources.x.input.id：要是带 type 与 label 的配置字段',
    ]);
  });

  it(`数据源名与动作名最多 ${FRAME_NAME_MAX_LENGTH} 个字符：插件前端发不出更长的名字；声明式页面的动作名不受限`, () => {
    const frame = { module: MODULE };
    const fit = 'n'.repeat(FRAME_NAME_MAX_LENGTH);
    const long = `${fit}n`;
    expect(problems({ frame, sources: { [fit]: { data: () => 1 } }, actions: { [fit]: act() } })).toEqual([]);
    expect(problems({ frame, sources: { [long]: { data: () => 1 } } })).toEqual([
      `sources：数据源的名字最多 ${FRAME_NAME_MAX_LENGTH} 个字符（插件前端发不出更长的名字）`,
    ]);
    expect(problems({ frame, actions: { [long]: act() } })).toEqual([
      `actions：插件前端的动作名最多 ${FRAME_NAME_MAX_LENGTH} 个字符（插件前端发不出更长的名字）`,
    ]);
    expect(problems({ content: [{ type: 'actions', actions: [long] }], actions: { [long]: act() } })).toEqual([]);
  });

  it('动作不带 row：插件前端里没有宿主画的表格行', () => {
    expect(problems({ frame: { module: MODULE }, actions: { remove: act({ row: true }) } })).toEqual([
      'actions.remove.row：插件前端的动作不带 row，要指定对象就放进 input',
    ]);
    expect(problems({ frame: { module: MODULE }, actions: { remove: act({ row: false }) } })).toEqual([
      'actions.remove.row：插件前端的动作不带 row，要指定对象就放进 input',
    ]);
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

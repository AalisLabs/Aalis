import { describe, expect, it } from 'vitest';
import type { BoundWebui, ComponentView, PageDataResponse, PageView } from '../../packages/api-webui/src/index.js';

// ════════════════════════════════════════════════════════════
// definePage 的类型推导：组件与处理函数一次声明，返回形状按组件种类推出，写错在编译期报错。
// 负向用例用 @ts-expect-error 钉住：该行若不再报错，test/architecture/test-types.test.ts 的 tsc 会把多余的
// expect-error 当错误报出来。函数只做类型检查，不运行。
// ════════════════════════════════════════════════════════════

function checks(webui: BoundWebui) {
  // 动作的输入按声明的字段推出；行动作收到 rowKey，页面动作收不到；数据源按组件种类给返回形状
  webui.definePage({
    key: 'jobs',
    title: '计划任务',
    actions: {
      pause: {
        label: '暂停',
        effect: 'write',
        row: true,
        handler({ rowKey, input }) {
          const key: string = rowKey;
          const none: undefined = input;
          return `已暂停 ${key}${none ?? ''}`;
        },
      },
      create: {
        label: '新建',
        effect: 'write',
        input: {
          name: { type: 'string', label: '名字', required: true },
          mode: {
            type: 'select',
            label: '方式',
            default: 'once',
            options: [
              { label: '一次', value: 'once' },
              { label: '每天', value: 'daily' },
            ],
          },
          limit: { type: 'number', label: '上限' },
        },
        async handler({ input, ctx }) {
          const name: string = input.name;
          const mode: 'once' | 'daily' = input.mode;
          const limit: number | undefined = input.limit;
          const user: string = ctx.caller.userId;
          return `${name}${mode}${limit}${user}`;
        },
      },
      remove: { label: '删除', effect: 'destructive', confirm: '删除后不能恢复', row: true, async handler() {} },
    },
    content: [
      {
        type: 'table',
        id: 'jobs',
        rowKey: 'name',
        columns: [{ key: 'name', label: '名字', primary: true }],
        rowActions: [{ action: 'pause', visibleWhen: 'running' }, { action: 'remove' }],
        data: () => [{ name: 'a', running: true }],
        detail: [
          {
            type: 'markdown',
            id: 'yaml',
            data: ({ rowKey }) => `# ${rowKey}`,
          },
          { type: 'actions', actions: ['remove'] },
        ],
      },
      { type: 'actions', actions: ['create'] },
      { type: 'info', id: 'summary', data: () => [{ label: '数量', value: 1 }] },
    ],
  });

  webui.definePage({
    key: 'refs',
    title: '引用',
    actions: { go: { label: '运行', effect: 'read', async handler() {} } },
    // @ts-expect-error 没有声明 nope 这个动作
    content: [{ type: 'actions', actions: ['nope'] }],
  });

  webui.definePage({
    key: 'no-actions',
    title: '没有动作',
    // @ts-expect-error 没有声明任何动作时一个都引用不了
    content: [{ type: 'actions', actions: ['go'] }],
  });

  webui.definePage({
    key: 'info',
    title: '键值',
    content: [
      {
        type: 'info',
        id: 'x',
        // @ts-expect-error 键值组件要返回「名称 → 值」的项，不是行
        data: () => [{ name: 'x' }],
      },
    ],
  });

  webui.definePage({
    key: 'markdown',
    title: '文字',
    content: [
      {
        type: 'markdown',
        id: 'x',
        // @ts-expect-error 文字组件要返回字符串
        data: () => 42,
      },
    ],
  });

  webui.definePage({
    key: 'top-row-key',
    title: '最外层没有 rowKey',
    content: [
      {
        type: 'markdown',
        id: 'x',
        // @ts-expect-error 只有详情里的数据源收到 rowKey
        data: ({ rowKey }) => rowKey,
      },
    ],
  });

  webui.definePage({
    key: 'panel',
    title: '会话面板',
    placement: 'session',
    applies: ({ kind }) => kind === 'room',
    content: [{ type: 'markdown', id: 'x', data: ({ ctx }) => ctx.sessionId }],
  });

  webui.definePage({
    key: 'plugin-ctx',
    title: '插件详情的页面',
    content: [
      {
        type: 'markdown',
        id: 'x',
        // @ts-expect-error 插件详情的页面没有会话
        data: ({ ctx }) => ctx.sessionId,
      },
    ],
  });

  webui.definePage({
    key: 'page-action',
    title: '页面动作',
    actions: {
      go: {
        label: '运行',
        effect: 'read',
        // @ts-expect-error 页面动作收不到 rowKey
        handler: ({ rowKey }) => rowKey,
      },
    },
    content: [{ type: 'actions', actions: ['go'] }],
  });

  webui.definePage({
    key: 'bad-input',
    title: '输入写错',
    actions: {
      go: {
        label: '运行',
        effect: 'write',
        // @ts-expect-error 输入字段的类型不认识
        input: { x: { type: 'strin', label: 'x' } },
        async handler() {},
      },
    },
    content: [{ type: 'actions', actions: ['go'] }],
  });

  webui.definePage({
    key: 'nested',
    title: '详情不再带详情',
    content: [
      {
        type: 'table',
        id: 'a',
        rowKey: 'id',
        columns: [{ key: 'id', label: 'id' }],
        data: () => [],
        detail: [
          {
            type: 'table',
            id: 'b',
            rowKey: 'id',
            columns: [{ key: 'id', label: 'id' }],
            data: () => [],
            // @ts-expect-error 详情里的组件不能再带详情
            detail: [{ type: 'markdown', id: 'c', data: () => '' }],
          },
        ],
      },
    ],
  });

  webui.definePage({
    key: 'tone',
    title: '关系图只收六种分类色',
    content: [
      {
        type: 'graph',
        id: 'g',
        // @ts-expect-error tone 只有 1 到 6
        nodeKinds: [{ kind: 'person', label: '人物', tone: 7 }],
        data: () => ({ nodes: [], edges: [] }),
      },
    ],
  });

  const handle = webui.definePage({ key: 'h', title: 'h', content: [{ type: 'markdown', id: 'm', data: () => '' }] });
  handle.invalidate('m', 'webui:a');
  webui.notify({ id: 'n', level: 'action', title: '3 件待裁决', open: { page: 'h' } }).clear();
  // @ts-expect-error 提示只有 action 与 error 两级
  webui.notify({ id: 'n', level: 'warning', title: 'x' });
}

// 界面收到的形状：声明去掉函数
function views(page: PageView, rows: PageDataResponse<'table'>) {
  const table: ComponentView = {
    type: 'table',
    id: 'list',
    rowKey: 'id',
    columns: [{ key: 'id', label: '编号', kind: 'file' }],
    detail: [{ type: 'markdown', id: 'm' }],
  };
  // @ts-expect-error 界面拿到的组件没有数据源
  const withData: ComponentView = { type: 'markdown', id: 'm', data: () => '' };
  const effect: 'read' | 'write' | 'destructive' | undefined = page.actions?.go?.effect;
  const cell = rows.data[0]?.report;
  return [table, withData, effect, cell];
}

describe('definePage 的类型推导', () => {
  it('只在编译期检查（test/architecture/test-types.test.ts 跑 tsc）', () => {
    expect([typeof checks, typeof views]).toEqual(['function', 'function']);
  });
});

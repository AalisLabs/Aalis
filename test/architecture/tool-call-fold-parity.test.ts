import { afterAll, describe, expect, it } from 'vitest';
import type { SessionItem } from '../../packages/api-session-protocol/src/index.js';
import * as cli from '../../packages/plugin-cli/src/fold.js';
import { duration } from '../../packages/plugin-webui-client/src/format.js';
import { setLanguage } from '../../packages/plugin-webui-client/src/language.js';
import * as webui from '../../packages/plugin-webui-client/src/workbench/fold.js';
import { type Localized, resolveSource, resolveText } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// 工具调用的收起规则 WebUI 与终端各有一份（plugin-webui-client 的 workbench/fold.ts，plugin-cli 的 fold.ts：收起是界面的取舍，
// 不进会话协议），两份必须是同一条规则：同一张用例表上，一段条目交出的行相同（收起的一组按 itemId 列出，单条按 itemId），收起那
// 一行的句子在原文与英文下逐字相同。用例表照 WebUI 时间线用例的几组写。工具行的用时与 WebUI 工具卡同一写法，同样在原文与英文下比
// ════════════════════════════════════════════════════════════

type Item = Localized<Exclude<SessionItem, { kind: 'turn' | 'plan' | 'usage' | 'queue' }>>;
type ToolCall = Extract<Item, { kind: 'tool-call' }>;

const AT = 0;
const tool = (itemId: string, name: string, fields: Partial<ToolCall> = {}): ToolCall => ({
  kind: 'tool-call',
  itemId,
  turnId: 't1',
  at: AT,
  name,
  args: {},
  status: 'completed',
  ...fields,
});
const command = (itemId: string, line: string, fields: Partial<ToolCall> = {}) =>
  tool(itemId, 'exec', { display: { kind: 'command', command: line }, ...fields });
const edit = (itemId: string, path: string) =>
  tool(itemId, 'file_edit', { display: { kind: 'file-change', path, removed: 'a', added: 'b' } });
const unknown = (itemId: string) =>
  tool(itemId, 'zz_fetch', { display: { kind: 'zz-fetch' } as unknown as ToolCall['display'] });
const reasoning = (itemId: string): Item => ({ kind: 'reasoning', itemId, turnId: 't1', at: AT, text: '想' });
const said = (itemId: string): Item => ({
  kind: 'agent-message',
  itemId,
  turnId: 't1',
  at: AT,
  text: '说',
  attachments: [],
});
const asked = (itemId: string): Item => ({
  kind: 'user-message',
  itemId,
  turnId: 't1',
  at: AT,
  text: '问',
  attachments: [],
  speaker: { platform: 'webui', userId: 'console', owner: true },
});

/** [名字, 一段的条目, 是还在跑的这一轮的最后一段, 还在跑的后台任务] */
const CASES: Array<[string, Item[], boolean, string[]]> = [
  [
    '按展示种类计数，夹着的思考一起收；写给用户的正文切开；2 个不收',
    [
      asked('u1'),
      command('c1', 'ls'),
      reasoning('r1'),
      edit('c2', 'a.ts'),
      tool('c3', 'web_search'),
      command('c4', 'pwd'),
      said('a1'),
      command('c5', 'git status'),
      command('c6', 'git diff'),
      said('a2'),
      command('c7', 'npm test'),
      command('c8', 'npm run lint'),
      command('c9', 'npm run build'),
    ],
    false,
    [],
  ],
  [
    '只有改文件的一组、只有通用调用的一组',
    [
      edit('f1', 'a.ts'),
      edit('f2', 'b.ts'),
      edit('f3', 'c.ts'),
      said('m1'),
      tool('g1', 'zz_a'),
      tool('g2', 'zz_b'),
      tool('g3', 'zz_c'),
    ],
    false,
    [],
  ],
  [
    '认不出的展示种类算作其他',
    [unknown('k1'), said('m1'), unknown('k2'), unknown('k3'), command('k4', 'ls')],
    false,
    [],
  ],
  [
    '有待审批、失败、运行中、正在生成的不收，被停止的照收',
    [
      command('c1', 'a1'),
      command('c2', 'a2'),
      command('c3', 'a3', { status: 'failed' }),
      said('m1'),
      command('c4', 'b1'),
      command('c5', 'b2', { approvalId: 'ap-1' }),
      command('c6', 'b3'),
      said('m2'),
      command('c7', 'c1'),
      command('c8', 'c2', { status: 'aborted' }),
      command('c9', 'c3'),
      said('m3'),
      command('e1', 'e1'),
      command('e2', 'e2', { status: 'running' }),
      command('e3', 'e3'),
      said('m4'),
      tool('g1', 'zz', { status: 'generating' }),
      command('g2', 'g2'),
      command('g3', 'g3'),
      said('m5'),
      command('s1', 's1', { approvalId: 'ap-2', settlement: { state: 'approved', source: 'answer', at: AT } }),
      command('s2', 's2', {
        status: 'denied',
        approvalId: 'ap-3',
        settlement: { state: 'denied', source: 'answer', at: AT },
      }),
      command('s3', 's3'),
    ],
    false,
    [],
  ],
  [
    '转到后台、任务还在跑的不收，任务结束的照收',
    [
      command('b1', 'b1', { taskId: 'task-1' }),
      command('b2', 'b2'),
      command('b3', 'b3'),
      said('m1'),
      command('b4', 'b4', { taskId: 'task-2' }),
      command('b5', 'b5'),
      command('b6', 'b6'),
    ],
    false,
    ['task-1'],
  ],
  [
    '还在跑的这一轮最后一段末尾那一组不收',
    [asked('u1'), command('d1', 'd1'), command('d2', 'd2'), command('d3', 'd3')],
    true,
    [],
  ],
  [
    '还在跑的这一轮最后一段：末尾之前的一组照收',
    [command('c1', 'ls'), command('c2', 'pwd'), command('c3', 'whoami'), asked('u2'), command('c4', 'date')],
    true,
    [],
  ],
];

const idsOf = (rows: ReadonlyArray<{ item: Item } | { group: readonly Item[] }>) =>
  rows.map(row => ('group' in row ? row.group.map(item => item.itemId) : row.item.itemId));
const groupsOf = <R extends { item: unknown } | { group: readonly Item[] }>(rows: readonly R[]) =>
  rows.flatMap(row =>
    'group' in row ? [row.group.filter((item): item is ToolCall => item.kind === 'tool-call')] : [],
  );

/** 原文与英文：WebUI 的语言链，与终端按同一条链渲染文字对象 */
const LANGUAGES = [
  [[], resolveSource],
  [['en'], (text: Parameters<typeof resolveSource>[0]) => resolveText(text, ['en'])],
] as const;

afterAll(() => setLanguage({ chain: [], timeZone: 'UTC', packs: new Map() }));

describe('工具调用的收起规则：WebUI 与终端同一条', () => {
  it.each(CASES)('%s', (_name, items, live, running) => {
    const taskRunning = (taskId: string) => running.includes(taskId);
    const webRows = webui.rowsOf(items, live, taskRunning);
    const cliRows = cli.rowsOf(items, live, taskRunning);
    expect(idsOf(cliRows)).toEqual(idsOf(webRows));
    const webGroups = groupsOf(webRows);
    for (const [chain, render] of LANGUAGES) {
      setLanguage({ chain, timeZone: 'UTC', packs: new Map() });
      expect(groupsOf(cliRows).map(calls => render(cli.groupSummary(calls)))).toEqual(
        webGroups.map(calls => webui.groupSummary(calls)),
      );
    }
  });

  it('工具行的用时与 WebUI 同一写法：十分之一秒的舍入、一分钟起写分与秒', () => {
    const durations = [0, 49, 50, 149, 150, 250, 350, 949, 950, 999, 1_050, 59_949, 59_950, 60_000, 65_400, 3_599_500];
    for (const [chain, render] of LANGUAGES) {
      setLanguage({ chain, timeZone: 'UTC', packs: new Map() });
      const language = cli.languageOf(render);
      const written = durations.map(ms => {
        const status = cli.toolLine(tool('d1', 'zz', { durationMs: ms }), () => false, language).status;
        return status && render(status.text);
      });
      expect(written).toEqual(durations.map(duration));
    }
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ════════════════════════════════════════════════════════════
// 会话页两处静默失真：
// ① 归档失败被空 catch 吞掉 —— 树不变、会话仍 active，用户以为点成功了；
// ② 两个开关的勾选状态回落读 resolved（含会话自身覆盖），取消勾选后
//    draft 变 undefined 又落回 resolved 的 true，勾立刻弹回去、关不掉。
//    正解是回落 inherited（继承默认），draft + inherited 即当前生效值。
// ════════════════════════════════════════════════════════════

const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
let replies: Record<string, unknown> = {};

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  pageAction: vi.fn(async (_plugin: string, method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    const r = replies[method];
    if (r instanceof Error) throw r;
    return r;
  }),
  api: vi.fn(async () => ({})),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
  proxiedMediaUrl: (s: string) => s,
}));

import { SessionsPage } from '../../packages/plugin-webui-client/src/pages/SessionsPage.js';

/** 会话自身把 disableOutputFormat 覆盖成 true；继承默认里它是关的 */
function makeReplies(): Record<string, unknown> {
  return {
    getSessionTree: [
      {
        key: 'owner',
        label: '我的会话',
        nodes: [
          {
            session: {
              id: 's1',
              name: 's1',
              title: '主会话',
              children: [],
              status: 'active',
              createdAt: 1,
              updatedAt: 2,
              config: { disableOutputFormat: true },
            },
            children: [],
          },
        ],
      },
    ],
    getConfigOptions: { personas: [], models: [], toolGroups: [] },
    getInheritance: { platform: 'webui', values: {}, sources: {} },
    archiveSession: { ok: true },
  };
}

/** getInheritance 的回包：平台、受众（房间会话才有）、继承值与每个键的来源层 */
function inheritance(
  values: Record<string, unknown>,
  sources: Record<string, string>,
  platform = 'webui',
  audience?: 'group' | 'private',
): { platform: string; audience?: string; values: Record<string, unknown>; sources: Record<string, string> } {
  return { platform, audience, values, sources };
}

/** 把树里唯一的会话换成带某份自身配置的 */
function withSessionConfig(config: Record<string, unknown>): void {
  const sections = replies.getSessionTree as Array<{ nodes: Array<{ session: { config: Record<string, unknown> } }> }>;
  sections[0].nodes[0].session.config = config;
}

async function openConfig(): Promise<void> {
  render(<SessionsPage pluginName="plugin-session-manager" />);
  fireEvent.click(await screen.findByTitle('配置'));
  await screen.findByText('白纸与远端');
}

async function saveAndGetPayload(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByText('保存'));
  await waitFor(() => expect(calls.some(c => c.method === 'updateSessionConfig')).toBe(true));
  return calls.find(c => c.method === 'updateSessionConfig')!.args.config as Record<string, unknown>;
}

beforeEach(() => {
  calls.length = 0;
  replies = makeReplies();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('会话归档失败', () => {
  it('归档抛错时出声告知，不再静默', async () => {
    replies.archiveSession = new Error('会话 s1 不存在');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<SessionsPage pluginName="plugin-session-manager" />);
    fireEvent.click(await screen.findByTitle('归档'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('会话 s1 不存在')));
  });

  it('归档成功不弹提示', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<SessionsPage pluginName="plugin-session-manager" />);
    fireEvent.click(await screen.findByTitle('归档'));
    await waitFor(() => expect(calls.some(c => c.method === 'archiveSession')).toBe(true));
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('会话配置开关', () => {
  it('取消勾选「禁用结构化输出」后保持不勾（不弹回）', async () => {
    render(<SessionsPage pluginName="plugin-session-manager" />);
    fireEvent.click(await screen.findByTitle('配置'));

    const box = (await screen.findByText(/禁用结构化输出/)).previousElementSibling as HTMLInputElement;
    expect(box.checked, '会话自身覆盖为 true：初始应勾上').toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(box.checked, '取消勾选必须保持取消').toBe(false));
  });

  it('继承默认为开时，未覆盖的会话显示勾上（继承语义不丢）', async () => {
    replies.getInheritance = inheritance({ clientSideJsonRendering: true }, { clientSideJsonRendering: 'platform' });
    render(<SessionsPage pluginName="plugin-session-manager" />);
    fireEvent.click(await screen.findByTitle('配置'));

    const box = (await screen.findByText(/客户端 JSON 渲染/)).previousElementSibling as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
  });

  it('继承为 true 时可取消勾选并保存出显式 false', async () => {
    // 三态的要害：取消勾选若写 undefined，保存时该键根本不出现（会话原本也没这键，
    // withRemovalsAsNull 也不会转 null），服务端仍按继承的 true 走——关不掉。
    replies.getInheritance = inheritance({ clientSideJsonRendering: true }, { clientSideJsonRendering: 'platform' });
    render(<SessionsPage pluginName="plugin-session-manager" />);
    fireEvent.click(await screen.findByTitle('配置'));

    const box = (await screen.findByText(/客户端 JSON 渲染/)).previousElementSibling as HTMLInputElement;
    await waitFor(() => expect(box.checked, '继承为 true：初始应勾上').toBe(true));
    fireEvent.click(box);
    await waitFor(() => expect(box.checked, '取消勾选必须保持取消').toBe(false));

    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(calls.some(c => c.method === 'updateSessionConfig')).toBe(true));
    const saved = calls.find(c => c.method === 'updateSessionConfig')!.args.config as Record<string, unknown>;
    expect(saved.clientSideJsonRendering, '显式关闭必须以 false 落到服务端').toBe(false);
  });

  it('未动过的开关不写入配置（保持继承，不被显式 false 覆盖）', async () => {
    replies.getInheritance = inheritance({ clientSideJsonRendering: true }, { clientSideJsonRendering: 'platform' });
    render(<SessionsPage pluginName="plugin-session-manager" />);
    fireEvent.click(await screen.findByTitle('配置'));
    await screen.findByText(/客户端 JSON 渲染/);

    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(calls.some(c => c.method === 'updateSessionConfig')).toBe(true));
    const saved = calls.find(c => c.method === 'updateSessionConfig')!.args.config as Record<string, unknown>;
    expect('clientSideJsonRendering' in saved, '没碰过的键不该出现在保存载荷里').toBe(false);
  });
});

describe('会话配置：白纸与远端', () => {
  it('取继承值走 getInheritance，只传会话 id，不再写死平台', async () => {
    await openConfig();
    const call = calls.find(c => c.method === 'getInheritance');
    expect(call?.args).toEqual({ sessionId: 's1' });
    expect(calls.some(c => c.method === 'getInheritedDefaults')).toBe(false);
  });

  it('新字段保存为扁平键', async () => {
    await openConfig();
    fireEvent.click(screen.getByLabelText(/开启白纸/));
    fireEvent.change(screen.getByLabelText(/白纸名/), { target: { value: '<试点白纸名>' } });
    fireEvent.change(screen.getByLabelText(/远端代理类型/), { target: { value: '<实例甲>, <实例乙>' } });
    fireEvent.change(screen.getByLabelText(/每人每天金额上限/), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/每人每天件数上限/), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/本房间每天金额上限/), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/记忆召回范围/), { target: { value: 'session' } });

    const saved = await saveAndGetPayload();
    expect(saved).toMatchObject({
      paperEnabled: true,
      paperName: '<试点白纸名>',
      remoteAgentTypes: ['<实例甲>', '<实例乙>'],
      remoteAgentUserDailyCents: 100,
      remoteAgentUserDailyTasks: 3,
      remoteAgentRoomDailyCents: 0,
      memoryRecallScope: 'session',
    });
  });

  it('清空已有覆盖时发 null（恢复继承）', async () => {
    withSessionConfig({
      paperName: '<旧白纸名>',
      remoteAgentTypes: ['<实例甲>'],
      remoteAgentUserDailyCents: 100,
      memoryRecallScope: 'platform',
    });
    await openConfig();
    fireEvent.change(screen.getByLabelText(/白纸名/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/远端代理类型/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/每人每天金额上限/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/记忆召回范围/), { target: { value: '' } });

    const saved = await saveAndGetPayload();
    expect(saved).toEqual({
      paperName: null,
      remoteAgentTypes: null,
      remoteAgentUserDailyCents: null,
      memoryRecallScope: null,
    });
  });

  it('未覆盖的键显示继承值与来源层', async () => {
    replies.getInheritance = inheritance(
      { paperEnabled: true, paperName: '<群白纸名>', remoteAgentRoomDailyCents: 500, memoryRecallScope: 'session' },
      {
        paperEnabled: 'platform',
        paperName: 'parent',
        remoteAgentRoomDailyCents: 'defaults',
        memoryRecallScope: 'platform',
      },
      'onebot',
    );
    await openConfig();
    expect(await screen.findByText('继承（开，来自 平台档 onebot）')).toBeTruthy();
    expect(screen.getByText('继承（<群白纸名>，来自 父会话）')).toBeTruthy();
    expect(screen.getByText('继承（500，来自 默认）')).toBeTruthy();
    expect(screen.getByText('继承（仅本会话，来自 平台档 onebot）')).toBeTruthy();
  });

  it('远端类型来自平台档时告警，来自父会话时不告警', async () => {
    replies.getInheritance = inheritance(
      { remoteAgentTypes: ['<实例甲>'] },
      { remoteAgentTypes: 'platform' },
      'onebot',
    );
    await openConfig();
    expect(await screen.findByText(/平台档里写了远端类型，这个平台所有房间都会继承/)).toBeTruthy();
    cleanup();

    replies.getInheritance = inheritance({ remoteAgentTypes: ['<实例甲>'] }, { remoteAgentTypes: 'parent' }, 'onebot');
    await openConfig();
    expect(screen.queryByText(/平台档里写了远端类型/)).toBeNull();
  });

  it('来源为平台档的受众条目时标出受众', async () => {
    replies.getInheritance = inheritance(
      { memoryRecallScope: 'session', paperEnabled: true },
      { memoryRecallScope: 'audience', paperEnabled: 'platform' },
      'onebot',
      'private',
    );
    await openConfig();
    expect(await screen.findByText('继承（仅本会话，来自 平台档 onebot（私聊））')).toBeTruthy();
    expect(screen.getByText('继承（开，来自 平台档 onebot）'), '基础档的键不标受众').toBeTruthy();
  });

  it('远端类型来自受众条目时同样告警，点明是这个平台的所有私聊或所有群', async () => {
    replies.getInheritance = inheritance(
      { remoteAgentTypes: ['<实例甲>'] },
      { remoteAgentTypes: 'audience' },
      'onebot',
      'private',
    );
    await openConfig();
    expect(await screen.findByText(/平台档里写了远端类型，这个平台的所有私聊都会继承/)).toBeTruthy();
    cleanup();

    replies.getInheritance = inheritance(
      { remoteAgentTypes: ['<实例甲>'] },
      { remoteAgentTypes: 'audience' },
      'onebot',
      'group',
    );
    await openConfig();
    expect(await screen.findByText(/平台档里写了远端类型，这个平台的所有群都会继承/)).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════
// 会话列表分区：服务端回分好区的树，页面按区画标题与节点；批量模式的全选只作用于所在分区；
// 子会话默认收起；删除 IM 房间的确认写清会清掉什么、房间之后还会回来。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

interface TreeNodeReply {
  session: Record<string, unknown>;
  children: TreeNodeReply[];
}

function node(id: string, title: string, children: TreeNodeReply[] = []): TreeNodeReply {
  return {
    session: {
      id,
      name: id,
      title,
      children: children.map(c => c.session.id),
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      config: {},
    },
    children,
  };
}

/** 我的会话 [WebUI 会话（带一个子会话）]；IM 房间 [群房间（带一个子任务）、私聊房间] */
function sectionedTree() {
  return [
    {
      key: 'owner',
      label: '我的会话',
      nodes: [node('session-abcd1234', '<WebUI 会话>', [node('session-abcd1234::ef012345', '<子会话>')])],
    },
    {
      key: 'rooms',
      label: 'IM 房间',
      nodes: [node(GROUP, '<群名>', [node(`${GROUP}::abcd1234`, '<子任务>')]), node(PRIVATE, '<乙>')],
    },
  ];
}

const rowOf = (title: string) => screen.getByText(title).closest('.tree-node') as HTMLElement;

describe('会话列表分区', () => {
  beforeEach(() => {
    replies.getSessionTree = sectionedTree();
    replies.batchArchive = { success: true };
  });

  it('两区标题与各自节点都画出；子会话默认收起，点开才显示', async () => {
    render(<SessionsPage pluginName="plugin-session-manager" />);
    const owner = await screen.findByRole('region', { name: '我的会话' });
    const rooms = screen.getByRole('region', { name: 'IM 房间' });

    expect(within(owner).getByText('<WebUI 会话>')).toBeTruthy();
    expect(within(owner).queryByText('<群名>')).toBeNull();
    expect(within(rooms).getByText('<群名>')).toBeTruthy();
    expect(within(rooms).getByText('<乙>')).toBeTruthy();

    expect(screen.queryByText('<子会话>'), '子会话默认收起').toBeNull();
    expect(screen.queryByText('<子任务>'), '子会话默认收起').toBeNull();
    fireEvent.click(within(rowOf('<群名>')).getByText('▸'));
    expect(within(rooms).getByText('<子任务>')).toBeTruthy();
    expect(screen.queryByText('<子会话>'), '只展开点开的那个').toBeNull();
  });

  it('批量模式的全选只选所在分区（含收起的子会话），不跨区', async () => {
    render(<SessionsPage pluginName="plugin-session-manager" />);
    fireEvent.click(await screen.findByTitle('批量管理'));
    expect(screen.getAllByText('全选'), '每个分区标题旁一个，没有跨区的全选').toHaveLength(2);

    const archivedIds = async () => {
      fireEvent.click(screen.getByText(/^归档 \(/));
      await waitFor(() => expect(calls.some(c => c.method === 'batchArchive')).toBe(true));
      const ids = calls.find(c => c.method === 'batchArchive')!.args.ids as string[];
      calls.length = 0;
      return [...ids].sort();
    };

    fireEvent.click(within(screen.getByRole('region', { name: '我的会话' })).getByText('全选'));
    expect(await archivedIds()).toEqual(['session-abcd1234', 'session-abcd1234::ef012345']);

    fireEvent.click(within(screen.getByRole('region', { name: 'IM 房间' })).getByText('全选'));
    expect(await archivedIds()).toEqual([`${GROUP}::abcd1234`, GROUP, PRIVATE].sort());
  });

  it('删除 IM 房间的确认写清会清掉消息历史与长期记忆、房间之后会重新出现；我的会话照旧', async () => {
    render(<SessionsPage pluginName="plugin-session-manager" />);
    fireEvent.click(within(await waitFor(() => rowOf('<群名>'))).getByTitle('删除'));
    const dialog = document.querySelector('.delete-confirm-dialog') as HTMLElement;
    expect(dialog.textContent).toContain('消息历史与长期记忆');
    expect(dialog.textContent).toContain('重新出现');
    fireEvent.click(within(dialog).getByText('取消'));

    fireEvent.click(within(rowOf('<WebUI 会话>')).getByTitle('删除'));
    const ownerDialog = document.querySelector('.delete-confirm-dialog') as HTMLElement;
    expect(ownerDialog.textContent).not.toContain('重新出现');
  });

  it('批量删除选中 1 个我的会话与 2 个 IM 房间：确认写出 IM 房间的个数与同一段说明', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SessionsPage pluginName="plugin-session-manager" />);
    fireEvent.click(await screen.findByTitle('批量管理'));
    for (const title of ['<WebUI 会话>', '<群名>', '<乙>']) fireEvent.click(screen.getByText(title));

    fireEvent.click(screen.getByText('删除 (3)'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const text = confirmSpy.mock.calls[0][0] as string;
    expect(text).toContain('2 个 IM 房间');
    expect(text).toContain('消息历史与长期记忆');
    expect(
      calls.some(c => c.method === 'batchDelete'),
      '取消确认就不删',
    ).toBe(false);
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebuiPageDef } from '../../packages/plugin-webui-client/src/types.js';

// ════════════════════════════════════════════════════════════
// 声明式页面（DynamicPage）的失败可见性 —— 旧行为只看 HTTP 状态：
// action 返回 {ok:false,error} 时路由回的是 200，表单照样显示「已保存」、
// 表格的危险操作静默刷新（scheduler 八处、workflow 五处业务失败全被显示成成功）。
// ════════════════════════════════════════════════════════════

const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
/** method → 返回值（或抛出的错误） */
let replies: Record<string, unknown> = {};
/** 经 api() 请求过的路径（动态选项等） */
const apiPaths: string[] = [];

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  pageAction: vi.fn(async (_plugin: string, method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    const r = replies[method];
    if (r instanceof Error) throw r;
    return r;
  }),
  api: vi.fn(async (path: string) => {
    apiPaths.push(path);
    if (path.startsWith('/api/models/')) {
      return { models: [], providers: [{ value: 'p/m1', model: 'm1', provider: 'p', contextId: 'p' }] };
    }
    return {};
  }),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
  proxiedMediaUrl: (s: string) => s,
}));

import { DynamicPage } from '../../packages/plugin-webui-client/src/components/DynamicPage.js';

const formPage: WebuiPageDef = {
  key: 'jobs',
  label: '定时任务',
  plugin: 'plugin-scheduler',
  content: [
    {
      type: 'form',
      label: '新建任务',
      source: 'getNewJobForm',
      save: 'createJob',
      schema: { name: { type: 'string', label: '任务名称' } },
    },
  ],
};

const actionsPage: WebuiPageDef = {
  key: 'ops',
  label: '运维',
  plugin: 'plugin-scheduler',
  content: [
    {
      type: 'actions',
      label: '操作',
      items: [{ label: '立即执行', method: 'runNow' }],
    },
  ],
};

const tablePage: WebuiPageDef = {
  key: 'jobs',
  label: '定时任务',
  plugin: 'plugin-scheduler',
  content: [
    {
      type: 'table',
      source: 'listJobs',
      columns: [{ key: 'name', label: '名称' }],
      actions: [
        { label: '删除', method: 'deleteJob', confirm: '确认删除？', danger: true },
        { label: '暂停', method: 'pauseJob' },
      ],
    },
  ],
};

beforeEach(() => {
  calls.length = 0;
  apiPaths.length = 0;
  replies = {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DynamicPage 表单保存', () => {
  it('action 返回 {ok:false,error}：显示服务端原因，不谎报「已保存」', async () => {
    replies = {
      getNewJobForm: { name: '' },
      createJob: { ok: false, error: 'interval 不能小于 5 秒（防高频任务耗尽资源）' },
    };
    render(<DynamicPage page={formPage} />);
    fireEvent.click(await screen.findByText('保存'));
    await waitFor(() => expect(screen.getByText(/interval 不能小于 5 秒/)).toBeTruthy());
    expect(screen.queryByText('已保存'), '业务失败不得显示成成功').toBeNull();
  });

  it('action 正常返回：显示「已保存」', async () => {
    replies = { getNewJobForm: { name: 'a' }, createJob: { ok: true } };
    render(<DynamicPage page={formPage} />);
    fireEvent.click(await screen.findByText('保存'));
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy());
  });

  it('action 抛错（路由 5xx）：显示错误文案', async () => {
    replies = { getNewJobForm: {}, createJob: new Error('处理器 createJob 不存在') };
    render(<DynamicPage page={formPage} />);
    fireEvent.click(await screen.findByText('保存'));
    await waitFor(() => expect(screen.getByText('处理器 createJob 不存在')).toBeTruthy());
  });
});

describe('DynamicPage 表单动态选项', () => {
  const dynFormPage: WebuiPageDef = {
    key: 'pick',
    label: '选择模型',
    plugin: 'plugin-third',
    content: [
      {
        type: 'form',
        source: 'getForm',
        save: 'saveForm',
        schema: { model: { type: 'select', label: '模型', dynamicOptions: 'svc/x' } },
      },
    ],
  };

  it('选项拉到后立即显示（不必等别的状态变化），服务名做 URL 编码', async () => {
    replies = { getForm: { model: '' } };
    render(<DynamicPage page={dynFormPage} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'p / m1' })).toBeTruthy());
    expect(apiPaths).toContain('/api/models/svc%2Fx');
  });
});

describe('DynamicPage 操作按钮组', () => {
  it('action 返回 {ok:false,error}：按钮旁显示原因，不谎报「完成」', async () => {
    replies = { runNow: { ok: false, error: '任务 daily-report 正在运行中' } };
    render(<DynamicPage page={actionsPage} />);
    fireEvent.click(await screen.findByText('立即执行'));
    await waitFor(() => expect(screen.getByText('任务 daily-report 正在运行中')).toBeTruthy());
    expect(screen.queryByText('完成'), '业务失败不得显示成成功').toBeNull();
  });

  it('action 正常返回：显示「完成」', async () => {
    replies = { runNow: { ok: true } };
    render(<DynamicPage page={actionsPage} />);
    fireEvent.click(await screen.findByText('立即执行'));
    await waitFor(() => expect(screen.getByText('完成')).toBeTruthy());
  });

  it('action 抛错：显示错误文案而非笼统「失败」', async () => {
    replies = { runNow: new Error('处理器 runNow 不存在') };
    render(<DynamicPage page={actionsPage} />);
    fireEvent.click(await screen.findByText('立即执行'));
    await waitFor(() => expect(screen.getByText('处理器 runNow 不存在')).toBeTruthy());
  });
});

describe('DynamicPage 表格行内操作', () => {
  it('危险操作返回 {ok:false,error}：出声告知，不静默刷新了事', async () => {
    replies = { listJobs: [{ name: 'daily-report' }], deleteJob: { ok: false, error: '任务不存在或已被删除' } };
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DynamicPage page={tablePage} />);
    fireEvent.click(await screen.findByText('删除'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('任务不存在或已被删除'));
  });

  it('操作抛错：出声告知错误文案', async () => {
    replies = { listJobs: [{ name: 'daily-report' }], deleteJob: new Error('插件 plugin-scheduler 不存在或未激活') };
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DynamicPage page={tablePage} />);
    fireEvent.click(await screen.findByText('删除'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('插件 plugin-scheduler 不存在或未激活'));
  });

  it('普通操作返回 {ok:true}：刷新表格而非弹出只有 ok 的「详情」', async () => {
    replies = { listJobs: [{ name: 'daily-report' }], pauseJob: { ok: true } };
    render(<DynamicPage page={tablePage} />);
    await screen.findByText('暂停');
    await waitFor(() => expect(calls.filter(c => c.method === 'listJobs').length).toBe(1));
    fireEvent.click(screen.getByText('暂停'));
    await waitFor(() => expect(calls.filter(c => c.method === 'listJobs').length, '操作后应重拉表格').toBe(2));
    expect(screen.queryByText('详情'), '操作回执不是详情，不该弹窗').toBeNull();
  });

  it('查看类操作返回不带 ok 的对象：弹出详情，不刷新表格', async () => {
    replies = { listJobs: [{ name: 'daily-report' }], pauseJob: { name: 'daily-report', lastError: 'timeout' } };
    render(<DynamicPage page={tablePage} />);
    await screen.findByText('暂停');
    await waitFor(() => expect(calls.filter(c => c.method === 'listJobs').length).toBe(1));
    fireEvent.click(screen.getByText('暂停'));
    await waitFor(() => expect(screen.getByText('lastError')).toBeTruthy());
    expect(calls.filter(c => c.method === 'listJobs').length, '详情展示不重拉表格').toBe(1);
  });
});

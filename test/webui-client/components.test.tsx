// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CircleStop, Ellipsis, Send } from 'lucide-react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Badge } from '../../packages/plugin-webui-client/src/components/Badge.js';
import { Button } from '../../packages/plugin-webui-client/src/components/Button.js';
import { Dialog } from '../../packages/plugin-webui-client/src/components/Dialog.js';
import { EmptyState } from '../../packages/plugin-webui-client/src/components/EmptyState.js';
import { IconButton } from '../../packages/plugin-webui-client/src/components/IconButton.js';
import { List, ListItem } from '../../packages/plugin-webui-client/src/components/List.js';
import { Menu } from '../../packages/plugin-webui-client/src/components/Menu.js';
import { Panel } from '../../packages/plugin-webui-client/src/components/Panel.js';
import { Select } from '../../packages/plugin-webui-client/src/components/Select.js';
import { TABLE_PAGE_SIZE, Table, type TableColumn } from '../../packages/plugin-webui-client/src/components/Table.js';
import { Tabs } from '../../packages/plugin-webui-client/src/components/Tabs.js';
import { ToastProvider, useToast } from '../../packages/plugin-webui-client/src/components/Toast.js';
import { Toggle } from '../../packages/plugin-webui-client/src/components/Toggle.js';
import { choose, installDialog } from './harness.js';

// ════════════════════════════════════════════════════════════
// 基础组件：键盘可达、焦点可见、读屏标签，以及各组件自己的行为（Toast 的计时、Menu 的方向键、Table 的筛选与全选）
// ════════════════════════════════════════════════════════════

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Button 与 IconButton', () => {
  it('默认是 type=button；进行中时不可点、标 aria-busy，图标换成旋转图标，文案不变', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button variant="primary" icon={Send} onClick={onClick}>
        发送
      </Button>,
    );
    const button = screen.getByRole('button', { name: '发送' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button variant="primary" icon={Send} onClick={onClick} busy>
        发送
      </Button>,
    );
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    expect(button.querySelector('svg')?.getAttribute('class')).toContain('spin');
    expect(button.textContent).toBe('发送');
  });

  it('图标按钮带读屏标签，悬停提示写上快捷键', () => {
    render(<IconButton icon={Ellipsis} label="搜索" shortcut="⌘K" />);
    const button = screen.getByRole('button', { name: '搜索' });
    expect(button.getAttribute('title')).toBe('搜索（⌘K）');
  });
});

describe('Dialog', () => {
  let restoreDialog: () => void;
  beforeAll(() => {
    restoreDialog = installDialog();
  });
  afterAll(() => restoreDialog());

  function Confirm({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          删除
        </button>
        <Dialog
          open={open}
          title="删除会话「周报」？"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          footer={
            <button type="button" data-autofocus>
              取消
            </button>
          }
        >
          删除后不能恢复。
        </Dialog>
      </>
    );
  }

  it('打开时以模态显示，焦点落在标了 data-autofocus 的元素上，标题就是对话框的名字', () => {
    render(<Confirm onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: '删除会话「周报」？' });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' }));
    expect(dialog.textContent).toContain('删除后不能恢复。');
  });

  it('Esc（cancel 事件）交给 onClose，由调用方关掉', () => {
    const onClose = vi.fn();
    render(<Confirm onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog');
    const cancel = new Event('cancel', { cancelable: true });
    act(() => {
      dialog.dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog.hasAttribute('open')).toBe(false);
  });
});

describe('Toast', () => {
  function Trigger({ toast }: { toast: Parameters<ReturnType<typeof useToast>>[0] }) {
    const show = useToast();
    return (
      <button type="button" onClick={() => show(toast)}>
        触发
      </button>
    );
  }

  const trigger = () => fireEvent.click(screen.getByRole('button', { name: '触发' }));

  it('成功的 4 秒后消失，悬停时暂停计时；通知区是礼貌的读屏播报区', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger toast={{ kind: 'success', text: '已归档' }} />
      </ToastProvider>,
    );
    trigger();
    const region = screen.getByRole('region', { name: '通知' });
    expect(region.getAttribute('aria-live')).toBe('polite');
    const toast = within(region).getByText('已归档');
    act(() => vi.advanceTimersByTime(3_000));
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByText('已归档')).not.toBeNull();
    fireEvent.mouseLeave(toast);
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByText('已归档')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('已归档')).toBeNull();
  });

  it('带动作的 8 秒后消失，点动作执行并关掉', () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    render(
      <ToastProvider>
        <Trigger toast={{ kind: 'success', text: '已归档', action: { label: '撤销', run: undo } }} />
      </ToastProvider>,
    );
    trigger();
    act(() => vi.advanceTimersByTime(7_999));
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('已归档')).toBeNull();
  });

  it('出错的（danger）不自动消失、立即播报，手动关；同时最多 3 条，旧的先走', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger toast={{ kind: 'danger', text: '删除失败：会话不存在' }} />
      </ToastProvider>,
    );
    trigger();
    act(() => vi.advanceTimersByTime(60_000));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('删除失败：会话不存在');
    // 语气名与颜色令牌同名，样式按它取危险色
    expect(alert.dataset.kind).toBe('danger');
    for (let i = 0; i < 3; i++) trigger();
    expect(screen.getAllByRole('alert')).toHaveLength(3);
    fireEvent.click(within(screen.getAllByRole('alert')[0]).getByRole('button', { name: '关闭' }));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });
});

describe('Panel、EmptyState 与 Badge', () => {
  it('Panel 是以标题命名的区域，头部放操作', () => {
    render(
      <Panel title="会话" actions={<IconButton icon={Ellipsis} label="新会话" />}>
        正文
      </Panel>,
    );
    const region = screen.getByRole('region', { name: '会话' });
    expect(within(region).getByRole('heading', { name: '会话' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: '新会话' })).toBeTruthy();
    expect(within(region).queryByRole('link')).toBeNull();
  });

  it('Panel 的 back 是回上一层的按钮（手机上逐层退回）', () => {
    render(
      <MemoryRouter initialEntries={['/rooms']}>
        <Routes>
          <Route
            path="/rooms"
            element={
              <Panel title="房间" back="/">
                正文
              </Panel>
            }
          />
          <Route path="/" element={<p>首页</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByText('首页')).toBeTruthy();
  });

  it('EmptyState 写缺什么、怎么得到，最多一个操作；出错时（danger）作为警示播报', () => {
    const { rerender } = render(<EmptyState title="还没有会话" description="发一条消息就会开始一个新会话" />);
    expect(screen.getByText('还没有会话')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(
      <EmptyState tone="danger" title="会话列表读取失败" description="连接断开" action={<Button>重试</Button>} />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('会话列表读取失败');
    expect(alert.dataset.tone).toBe('danger');
    expect(within(alert).getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('Badge 的数字用计数样式', () => {
    render(
      <>
        <Badge tone="attention">{3}</Badge>
        <Badge>平台档</Badge>
      </>,
    );
    expect(screen.getByText('3').hasAttribute('data-count')).toBe(true);
    expect(screen.getByText('平台档').hasAttribute('data-count')).toBe(false);
    expect(screen.getByText('3').getAttribute('data-tone')).toBe('attention');
  });
});

describe('List', () => {
  it('行整行可点，当前项标 aria-current，行首标记带读屏文字，「更多」在行外', () => {
    render(
      <MemoryRouter>
        <List label="我的">
          <ListItem to="/s/a" title="整理周报" detail="等你批准 · 执行命令" meta="10:12" marker="attention" current />
          <ListItem
            to="/s/b"
            title="读书会"
            marker="unread"
            menu={<Menu label="更多" items={[{ label: '改名', onSelect: () => {} }]} />}
          />
        </List>
      </MemoryRouter>,
    );
    const list = screen.getByRole('list', { name: '我的' });
    const [first, second] = within(list).getAllByRole('link');
    expect(first.getAttribute('href')).toBe('/s/a');
    expect(first.getAttribute('aria-current')).toBe('page');
    expect(first.textContent).toContain('需要处理');
    expect(second.getAttribute('aria-current')).toBeNull();
    expect(second.textContent).toContain('未读');
    expect(within(second).queryByRole('button')).toBeNull();
    expect(within(list).getByRole('button', { name: '更多' })).toBeTruthy();
  });

  it('行尾常显的一个操作在链接外面；子列表挂在这一行下面', () => {
    const stop = vi.fn();
    render(
      <MemoryRouter>
        <List label="子会话">
          <ListItem
            to="/s/p"
            title="父会话"
            action={<IconButton icon={CircleStop} label="停止「父会话」" onClick={stop} />}
          >
            <List label="下一层">
              <ListItem to="/s/c" title="子任务一" />
            </List>
          </ListItem>
        </List>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: '父会话' });
    expect(within(link).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '停止「父会话」' }));
    expect(stop).toHaveBeenCalledOnce();
    const parent = link.closest('li') as HTMLElement;
    expect(within(within(parent).getByRole('list', { name: '下一层' })).getByRole('link').textContent).toBe('子任务一');
  });
});

describe('Tabs', () => {
  function Panes() {
    const [value, setValue] = useState('plan');
    return (
      <Tabs
        label="会话面板"
        items={[
          { key: 'plan', title: '计划' },
          { key: 'settings', title: '设置' },
          { key: 'usage', title: '用量' },
        ]}
        value={value}
        onChange={setValue}
      >
        {`内容：${value}`}
      </Tabs>
    );
  }

  it('左右方向键切换并移动焦点，Home、End 到两端，只有选中的标签在 Tab 顺序里', () => {
    render(<Panes />);
    const [plan, settings, usage] = screen.getAllByRole('tab');
    expect(plan.getAttribute('aria-selected')).toBe('true');
    expect(settings.tabIndex).toBe(-1);
    const panel = screen.getByRole('tabpanel', { name: '计划' });
    expect(panel.textContent).toBe('内容：plan');

    fireEvent.keyDown(plan, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(settings);
    expect(settings.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: '设置' }).textContent).toBe('内容：settings');
    fireEvent.keyDown(settings, { key: 'End' });
    expect(document.activeElement).toBe(usage);
    fireEvent.keyDown(usage, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(plan);
    fireEvent.keyDown(plan, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(usage);
    fireEvent.keyDown(usage, { key: 'Home' });
    expect(plan.getAttribute('aria-selected')).toBe('true');
  });
});

describe('Toggle', () => {
  it('是带状态的开关，点击切换', () => {
    function Switch() {
      const [on, setOn] = useState(false);
      return <Toggle label="深度思考" checked={on} onChange={setOn} />;
    }
    render(<Switch />);
    const toggle = screen.getByRole('switch', { name: '深度思考' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Menu', () => {
  const rename = vi.fn();
  const remove = vi.fn();
  const items = [
    { label: '改名', onSelect: rename },
    { label: '删除', onSelect: remove, danger: true },
  ];

  it('方向键打开并在项之间移动，Esc 关闭并把焦点还给按钮', () => {
    render(<Menu label="更多" items={items} />);
    const trigger = screen.getByRole('button', { name: '更多' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: '更多' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const [first, second] = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute('data-danger')).toBe('true');
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('选中一项：关闭、焦点回到按钮、执行动作；点在菜单外面关闭', () => {
    render(<Menu label="更多" items={items} />);
    const trigger = screen.getByRole('button', { name: '更多' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: '改名' }));
    expect(rename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Tab 离开菜单时关闭', () => {
    render(<Menu label="更多" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: '改名' }), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Select', () => {
  const FEW = [
    { value: 'info', label: '信息' },
    { value: 'warn', label: '警告' },
    { value: 'gone', label: '已下线', disabled: true },
    { value: 'error', label: '错误' },
  ];
  const MANY = Array.from({ length: 12 }, (_, index) => ({ value: `m${index}`, label: `model-${index}` }));

  function Picker({ options, initial = '' }: { options: typeof FEW; initial?: string }) {
    const [value, setValue] = useState(initial);
    return (
      <>
        <Select aria-label="级别" value={value} options={options} placeholder="全部" onChange={setValue} />
        <output data-testid="chosen">{value}</output>
      </>
    );
  }

  const chosen = () => screen.getByTestId('chosen').textContent;

  it('按钮写选中的那一项，读屏标签是名字；点开列出选项、标出选中的，点一项交出它的值、关闭并把焦点还给按钮', () => {
    render(<Picker options={FEW} initial="warn" />);
    const trigger = screen.getByRole('combobox', { name: '级别' });
    expect(trigger.textContent).toBe('警告');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('listbox', { name: '级别' });
    expect(
      within(list)
        .getAllByRole('option')
        .map(option => option.textContent),
    ).toEqual(['信息', '警告', '已下线', '错误']);
    expect(within(list).getByRole('option', { name: '警告' }).getAttribute('aria-selected')).toBe('true');
    expect(within(list).getByRole('option', { name: '已下线' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(list).getByRole('option', { name: '已下线' }));
    expect(chosen()).toBe('warn');
    fireEvent.click(within(list).getByRole('option', { name: '错误' }));
    expect(chosen()).toBe('error');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toBe('错误');
  });

  it('没选时写占位的字；选项少时没有过滤框，方向键在可选的项之间移动（跳过不可选的），回车选中，Esc 关闭不改', () => {
    render(<Picker options={FEW} />);
    const trigger = screen.getByRole('combobox', { name: '级别' });
    expect(trigger.textContent).toBe('全部');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(document.activeElement).toBe(list);
    const active = () => document.getElementById(list.getAttribute('aria-activedescendant') ?? '')?.textContent;
    expect(active()).toBe('信息');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(active()).toBe('错误');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(active()).toBe('信息');
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(active()).toBe('警告');
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(chosen()).toBe('');
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    expect(chosen()).toBe('warn');
  });

  it('选项多时有过滤框：只留下名字含所写文字的项（不分大小写），方向键移动、回车选中；没有匹配的写明', () => {
    render(<Picker options={MANY} />);
    fireEvent.click(screen.getByRole('combobox', { name: '级别' }));
    const filter = screen.getByRole('searchbox', { name: '过滤' });
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: 'MODEL-1' } });
    const list = screen.getByRole('listbox');
    expect(
      within(list)
        .getAllByRole('option')
        .map(option => option.textContent),
    ).toEqual(['model-1', 'model-10', 'model-11']);
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(chosen()).toBe('m10');
    fireEvent.click(screen.getByRole('combobox', { name: '级别' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '过滤' }), { target: { value: '没有这个' } });
    expect(within(screen.getByRole('listbox')).queryAllByRole('option')).toEqual([]);
    expect(screen.getByText('没有符合的项')).toBeTruthy();
  });

  it('打开时把选中的那一项滚进视野：长列表里选中的在下面也看得到', () => {
    const scrolled: string[] = [];
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this.textContent ?? '');
    });
    onTestFinished(() => scroll.mockRestore());
    render(<Picker options={MANY} initial="m11" />);
    fireEvent.click(screen.getByRole('combobox', { name: '级别' }));
    expect(scrolled).toEqual(['model-11']);
  });

  it('点在外面、Tab 离开时关闭', () => {
    render(<Select aria-label="级别" value="" options={FEW} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  describe('在模态对话框里', () => {
    let restoreDialog: () => void;
    beforeAll(() => {
      restoreDialog = installDialog();
    });
    afterAll(() => restoreDialog());

    it('弹层挂在对话框里（对话框外面的东西点不到），Esc 只关弹层、不关对话框', () => {
      const onClose = vi.fn();
      render(
        <Dialog open title="表单" onClose={onClose}>
          <Picker options={FEW} />
        </Dialog>,
      );
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('combobox', { name: '级别' }));
      const list = within(dialog).getByRole('listbox');
      const notCancelled = fireEvent.keyDown(list, { key: 'Escape' });
      expect(notCancelled).toBe(false);
      expect(within(dialog).queryByRole('listbox')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

describe('Table', () => {
  interface Room {
    id: string;
    name: string;
    type: 'group' | 'private';
    active: number;
  }
  const columns: TableColumn<Room>[] = [
    { key: 'name', label: '名称', primary: true, render: row => row.name, sortValue: row => row.name },
    { key: 'type', label: '类型', render: row => (row.type === 'group' ? '群' : '私聊') },
    {
      key: 'active',
      label: '最后活动',
      render: row => String(row.active),
      sortValue: row => row.active,
    },
  ];
  const rooms = (n: number): Room[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      name: `房间 ${String(i).padStart(3, '0')}`,
      type: i % 2 ? 'private' : 'group',
      active: i,
    }));
  const names = () =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map(row => row.querySelector('td[data-column="name"]')?.textContent);

  it('点表头排序，aria-sort 跟着变；不可排序的列表头不是按钮', () => {
    render(<Table label="房间" rows={rooms(3)} rowKey={row => row.id} columns={columns} empty="还没有房间" />);
    expect(screen.queryByRole('button', { name: '类型' })).toBeNull();
    const header = screen.getByRole('columnheader', { name: '最后活动' });
    fireEvent.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(names()).toEqual(['房间 000', '房间 001', '房间 002']);
    fireEvent.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(names()).toEqual(['房间 002', '房间 001', '房间 000']);
  });

  it('不超过一页时没有搜索框与分页，超过一页才出现；搜索在客户端做，换页按页显示', () => {
    const { rerender } = render(
      <Table
        label="房间"
        rows={rooms(TABLE_PAGE_SIZE)}
        rowKey={row => row.id}
        columns={columns}
        empty="还没有房间"
        search={row => row.name}
      />,
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('navigation', { name: '分页' })).toBeNull();

    rerender(
      <Table
        label="房间"
        rows={rooms(TABLE_PAGE_SIZE + 5)}
        rowKey={row => row.id}
        columns={columns}
        empty="还没有房间"
        search={row => row.name}
      />,
    );
    expect(screen.getAllByRole('row')).toHaveLength(TABLE_PAGE_SIZE + 1);
    const pager = screen.getByRole('navigation', { name: '分页' });
    fireEvent.click(within(pager).getByRole('button', { name: '下一页' }));
    expect(screen.getAllByRole('row')).toHaveLength(5 + 1);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索房间' }), { target: { value: '房间 00' } });
    expect(names()).toHaveLength(10);
  });

  it('筛选由调用方持有；筛选出空时写明并能清除筛选', () => {
    const onChange = vi.fn();
    const filter = {
      fields: [
        {
          key: 'type',
          label: '类型',
          options: [
            { value: 'group', label: '群' },
            { value: 'private', label: '私聊' },
          ],
          matches: (row: Room, value: string) => row.type === value,
        },
      ],
      onChange,
    };
    const { rerender } = render(
      <Table
        label="房间"
        rows={rooms(4)}
        rowKey={row => row.id}
        columns={columns}
        empty="还没有房间"
        filter={{ ...filter, values: { type: 'private' } }}
      />,
    );
    expect(names()).toEqual(['房间 001', '房间 003']);
    choose(screen.getByRole('combobox', { name: '类型' }), '群');
    expect(onChange).toHaveBeenLastCalledWith({ type: 'group' });

    rerender(
      <Table
        label="房间"
        rows={rooms(4).filter(row => row.type === 'group')}
        rowKey={row => row.id}
        columns={columns}
        empty="还没有房间"
        filter={{ ...filter, values: { type: 'private' } }}
      />,
    );
    expect(screen.getByText('没有符合筛选的项')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('没有数据时保留表头，正文写空状态', () => {
    render(<Table label="房间" rows={[]} rowKey={row => row.id} columns={columns} empty="这一组还没有房间" />);
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getByText('这一组还没有房间')).toBeTruthy();
  });

  it('全选只作用于当前的筛选结果，批量动作拿到的也只有筛选结果里选中的', () => {
    function Selectable() {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['r1']));
      const [values, setValues] = useState<Record<string, string>>({ type: 'group' });
      return (
        <Table
          label="房间"
          rows={rooms(6)}
          rowKey={row => row.id}
          columns={columns}
          empty="还没有房间"
          filter={{
            fields: [
              {
                key: 'type',
                label: '类型',
                options: [
                  { value: 'group', label: '群' },
                  { value: 'private', label: '私聊' },
                ],
                matches: (row, value) => row.type === value,
              },
            ],
            values,
            onChange: setValues,
          }}
          selection={{
            selected,
            onChange: setSelected,
            rowLabel: row => row.name,
            actions: keys => <output>{keys.join(',')}</output>,
          }}
        />
      );
    }
    render(<Selectable />);
    // r1 是私聊，被筛掉了：不算进批量
    expect(screen.queryByRole('status')).toBeNull();
    const all = screen.getByRole('checkbox', { name: '全选筛选结果' });
    fireEvent.click(all);
    expect(screen.getByRole('status').textContent).toBe('r0,r2,r4');
    expect(screen.getByText('已选 3 项')).toBeTruthy();
    // 筛掉的行没被全选带上：换成私聊，只剩原先选的 r1
    choose(screen.getByRole('combobox', { name: '类型' }), '私聊');
    expect(screen.getByRole('status').textContent).toBe('r1');
    choose(screen.getByRole('combobox', { name: '类型' }), '群');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 房间 002' }));
    expect(screen.getByRole('status').textContent).toBe('r0,r4');
    expect((all as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(all);
    expect(screen.getByRole('status').textContent).toBe('r0,r2,r4');
    fireEvent.click(all);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('勾选框的可点区是一个控件见方（触屏上随令牌放大）：点框旁边也能勾上', () => {
    function Selectable() {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
      return (
        <Table
          label="房间"
          rows={rooms(3)}
          rowKey={row => row.id}
          columns={columns}
          empty="还没有房间"
          selection={{
            selected,
            onChange: setSelected,
            rowLabel: row => row.name,
            actions: keys => <output>{keys.join(',')}</output>,
          }}
        />
      );
    }
    render(<Selectable />);
    const hitArea = (name: string) => {
      const label = screen.getByRole('checkbox', { name }).closest('label');
      expect(label?.parentElement?.className).toBe('table-check');
      return label as HTMLLabelElement;
    };
    fireEvent.click(hitArea('选择 房间 001'));
    expect(screen.getByRole('status').textContent).toBe('r1');
    fireEvent.click(hitArea('全选筛选结果'));
    expect(screen.getByRole('status').textContent).toBe('r0,r1,r2');
  });
});

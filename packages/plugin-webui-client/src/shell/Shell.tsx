import type { HostPanelTab } from '@aalis/api-webui';
import { type LucideIcon, MessagesSquare } from 'lucide-react';
import {
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, matchPath, Outlet, useLocation, useNavigate } from 'react-router';
import { Badge } from '../components/Badge';
import { useConnection } from '../connection';
import { useAttention } from '../health/attention';
import { shortcutLabel, shortcutOf } from '../keys';
import { PinnedRail } from '../pages/Pinned';
import { pageAt, paths, routes } from '../routes';
import { useMine } from '../sessions/mine';
import { readStored, writeStored } from '../storage';
import { ConnectionBar } from './ConnectionBar';
import { countNote, HOST_ENTRIES, type HostArea, useEntryCounts } from './entries';
import { QuickSwitch } from './QuickSwitch';
import './Shell.css';

// 外壳：图标栏、左栏、主区、右侧面板。左栏 64em 起、右侧面板 80em 起常驻，可收起，两侧之间的分隔条可以拖动调宽；
// 更窄时它们是按记住的栏宽盖进来的抽屉；48em 以下是手机，没有图标栏，按地址逐层进入，每层占满一屏。
// 收起状态与栏宽按设备存本浏览器。图标栏上方是「会话」，下面是 owner 固定的页面，底部是运行状况、插件与设置；
// 不在某一区时点它回到刚才在这一区的地址，已在这一区时点它收起或展开左栏（运行状况没有左栏）。角标只有运行状况一个

type Side = 'left' | 'right';

/** 图标栏上的几区：会话与宿主的入口；打开着插件页面时不在任何一区 */
type Area = 'sessions' | HostArea;

const DOCKED: Record<Side, string> = { left: '(min-width: 64em)', right: '(min-width: 80em)' };
const PHONE = '(max-width: 47.99em)';

/** 两侧的栏宽（rem）：默认值与可调的上下限 */
const WIDTHS: Record<Side, { initial: number; min: number; max: number }> = {
  left: { initial: 16.5, min: 13.75, max: 25 },
  right: { initial: 22.5, min: 18.75, max: 37.5 },
};
/** 分隔条上按一下方向键调的宽度（rem） */
const WIDTH_STEP = 1;

/** 一侧在常驻宽度下展开没有，调过的栏宽（rem，没调过是默认宽度） */
interface SideLayout {
  open: boolean;
  width?: number;
}
type Layout = Record<Side, SideLayout>;

const clampWidth = (side: Side, width: number) => Math.min(Math.max(width, WIDTHS[side].min), WIDTHS[side].max);

function storedLayout(): Layout {
  const stored = readStored('panels') as Partial<Record<Side, Partial<SideLayout>>> | undefined;
  const sideOf = (side: Side): SideLayout => {
    const { open, width } = stored?.[side] ?? {};
    return {
      open: typeof open === 'boolean' ? open : true,
      width: typeof width === 'number' && Number.isFinite(width) ? clampWidth(side, width) : undefined,
    };
  };
  return { left: sideOf('left'), right: sideOf('right') };
}

interface ShellControls {
  /** 打开着的抽屉 */
  drawer?: Side;
  /** 常驻宽度下收起或展开，覆盖式宽度下开关抽屉，手机上不起作用 */
  toggle(side: Side): void;
  /** 常驻宽度下展开，覆盖式宽度下打开抽屉，手机上不起作用 */
  reveal(side: Side): void;
  closeDrawer(): void;
  openSearch(): void;
  /** 两侧记住的栏宽（rem） */
  widths: Record<Side, number>;
  /** 定下栏宽并记住；不给宽度时恢复默认 */
  resize(side: Side, width?: number): void;
}

const Context = createContext<ShellControls | undefined>(undefined);

export function useShell(): ShellControls {
  const controls = useContext(Context);
  if (!controls) throw new Error('只能在外壳里取外壳的控制');
  return controls;
}

export function usePhone(): boolean {
  return useSyncExternalStore(
    listener => {
      const query = matchMedia(PHONE);
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => matchMedia(PHONE).matches,
  );
}

export function Shell() {
  const [layout, setLayout] = useState(storedLayout);
  const [drawer, setDrawer] = useState<Side>();
  const [searching, setSearching] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const { appName } = useConnection();
  const attention = useAttention().items?.length ?? 0;
  const countOf = useEntryCounts();
  const unread = useMine().sessions?.filter(session => session.unread).length ?? 0;

  const save = useCallback(
    (side: Side, fields: Partial<SideLayout>) => {
      const next = { ...layout, [side]: { ...layout[side], ...fields } };
      setLayout(next);
      writeStored('panels', next);
    },
    [layout],
  );

  /** 按一侧现在开着没有，定它接下来开不开 */
  const change = useCallback(
    (side: Side, decide: (open: boolean) => boolean) => {
      if (matchMedia(PHONE).matches) return;
      if (!matchMedia(DOCKED[side]).matches) {
        setDrawer(current => (decide(current === side) ? side : current === side ? undefined : current));
        return;
      }
      const open = decide(layout[side].open);
      if (open !== layout[side].open) save(side, { open });
    },
    [layout, save],
  );
  const toggle = useCallback((side: Side) => change(side, open => !open), [change]);

  const widths = useMemo(
    () => ({
      left: layout.left.width ?? WIDTHS.left.initial,
      right: layout.right.width ?? WIDTHS.right.initial,
    }),
    [layout],
  );

  const controls = useMemo<ShellControls>(
    () => ({
      drawer,
      toggle,
      reveal: side => change(side, () => true),
      closeDrawer: () => setDrawer(undefined),
      openSearch: () => setSearching(true),
      widths,
      resize: (side, width) => save(side, { width }),
    }),
    [drawer, toggle, change, widths, save],
  );

  // 标签页标题前的数：「需要处理」加「我的」区完成未读的会话，都为 0 时只有应用名
  const count = attention + unread;
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${appName}` : appName;
  }, [count, appName]);

  // 抽屉里的左栏点了会话、换了地址就收回
  useEffect(() => setDrawer(current => (current === 'left' ? undefined : current)), [location.key]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcut = event.defaultPrevented ? undefined : shortcutOf(event);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut === 'search') setSearching(true);
      else if (shortcut === 'newSession') navigate(paths.newSession);
      else toggle(shortcut === 'toggleLeft' ? 'left' : 'right');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navigate, toggle]);

  const area = areaOf(location.pathname);
  // 每一区最近一次的地址：从别处点回这一区时回到它
  const lastAddress = useRef<Partial<Record<Area, string>>>({});
  useEffect(() => {
    if (area) lastAddress.current[area] = location.pathname + location.search;
  }, [area, location]);
  const railItem = (to: Area, label: string, Icon: LucideIcon, home: string, count?: number) => (
    <RailItem
      key={to}
      label={label}
      icon={Icon}
      count={count}
      current={area === to}
      to={lastAddress.current[to] ?? home}
      toggleLeft={to === 'health' ? undefined : () => toggle('left')}
    />
  );

  return (
    <Context.Provider value={controls}>
      <div
        className="shell"
        data-phone={phoneColumn(location.pathname)}
        data-left={layout.left.open ? undefined : 'collapsed'}
        data-right={layout.right.open ? undefined : 'collapsed'}
        data-drawer={drawer}
        style={
          {
            '--left-w': `${widths.left}rem`,
            '--left-min': `${WIDTHS.left.min}rem`,
            '--right-w': `${widths.right}rem`,
            '--right-min': `${WIDTHS.right.min}rem`,
          } as CSSProperties
        }
      >
        <ConnectionBar />
        <div className="shell-columns">
          <nav className="shell-rail" aria-label="图标栏">
            <div className="header-bar shell-rail-head">{railItem('sessions', '会话', MessagesSquare, paths.home)}</div>
            <PinnedRail />
            <div className="shell-rail-tail">
              {HOST_ENTRIES.map(entry =>
                railItem(entry.area, entry.label, entry.icon, entry.path, countOf(entry.area)),
              )}
            </div>
          </nav>
          <Outlet />
        </div>
        {drawer && (
          <button
            type="button"
            className="shell-scrim"
            data-side={drawer}
            tabIndex={-1}
            aria-label="关上"
            onClick={controls.closeDrawer}
          />
        )}
      </div>
      <QuickSwitch open={searching} onClose={() => setSearching(false)} />
    </Context.Provider>
  );
}

/** 地址所在的区：插件页面（/p/ 地址）不算任何一区；市场不占 /plugins/ 下的名字，归插件区 */
function areaOf(pathname: string): Area | undefined {
  if (pageAt(pathname)) return undefined;
  if (matchPath(routes.market, pathname)) return 'plugins';
  for (const entry of HOST_ENTRIES) if (matchPath({ path: entry.path, end: false }, pathname)) return entry.area;
  return 'sessions';
}

/**
 * 手机上占满一屏的一栏：第一层、插件树与设置目录是左栏；会话面板的标签与插件的会话面板是右侧面板（用量从底部弹出，不算）
 */
function phoneColumn(pathname: string): Side | 'main' {
  if (pathname === routes.home || pathname === routes.plugins || pathname === routes.settings) return 'left';
  const tab = matchPath(routes.sessionTab, pathname)?.params.tab;
  if (matchPath(routes.sessionPanel, pathname) || (tab !== undefined && tab !== ('usage' satisfies HostPanelTab))) {
    return 'right';
  }
  return 'main';
}

interface RailItemProps {
  label: string;
  icon: LucideIcon;
  /** 角标上的数，没有时不带角标 */
  count?: number;
  current: boolean;
  to: string;
  /** 这一区有左栏：已在这一区时点它收起或展开左栏 */
  toggleLeft?(): void;
}

/** 图标栏上宿主的一区 */
function RailItem({ label, icon: Icon, count, current, to, toggleLeft }: RailItemProps) {
  const name = count === undefined ? label : label + countNote(count);
  return (
    <Link
      to={to}
      className="shell-rail-item"
      aria-current={current ? 'page' : undefined}
      aria-label={name}
      title={current && toggleLeft ? `${name}（${shortcutLabel('toggleLeft')} 收起或展开左栏）` : name}
      onClick={event => {
        if (!current || !toggleLeft) return;
        event.preventDefault();
        toggleLeft();
      }}
    >
      <Icon aria-hidden />
      {count !== undefined && <Badge tone="attention">{count}</Badge>}
      <span className="shell-rail-name" aria-hidden>
        {label}
      </span>
    </Link>
  );
}

/** 抽屉打开时焦点移进去，Esc 关上；关上时焦点在里面就还给打开前的元素 */
function useDrawer(side: Side) {
  const { drawer, closeDrawer } = useShell();
  const ref = useRef<HTMLElement>(null);
  const open = drawer === side;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (ref.current?.contains(document.activeElement)) opener?.focus();
    };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    closeDrawer();
  };
  return { ref, onKeyDown };
}

const SEPARATOR_LABEL: Record<Side, string> = { left: '调整左栏宽度', right: '调整右侧面板宽度' };

interface SeparatorProps {
  side: Side;
  /** 拖动中的栏宽（rem）只用在这一栏上，松手时撤掉（给 undefined），再按松手的位置定下或收起 */
  onDrag(width?: number): void;
}

/**
 * 两侧停靠时栏与主区之间的分隔条（只在常驻宽度下显示）：按住拖动、方向键调宽，Home、End 到上下限，双击恢复默认；
 * 拖到下限以下松手即收起，与按钮、快捷键收起是同一个状态，栏宽留着拖动前的，展开时回到它
 */
function Separator({ side, onDrag }: SeparatorProps) {
  const { widths, toggle, resize } = useShell();
  const drag = useRef<{ pointer: number; from: number; rem: number; to?: number }>(undefined);
  const { min, max } = WIDTHS[side];
  /** 往外是加宽：左栏的分隔条往右，右侧面板的往左 */
  const outward = side === 'left' ? 1 : -1;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 不让按住拖动时选中旁边的文字
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.clientX,
      from: widths[side],
      rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    current.to = current.from + ((event.clientX - current.pointer) * outward) / current.rem;
    onDrag(clampWidth(side, current.to));
  };
  const end = (commit: boolean) => {
    const to = drag.current?.to;
    drag.current = undefined;
    onDrag(undefined);
    // 没有移动过的是点按，不改栏宽
    if (!commit || to === undefined) return;
    if (to < min) toggle(side);
    else resize(side, clampWidth(side, to));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      next = widths[side] + (event.key === 'ArrowRight' ? outward : -outward) * WIDTH_STEP;
    } else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    else return;
    event.preventDefault();
    resize(side, clampWidth(side, next));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> 不能获得焦点、不能拖动，可调的分隔条只能用 role="separator"
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={SEPARATOR_LABEL[side]}
      aria-valuenow={widths[side]}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="拖动调整宽度，双击恢复默认"
      className="shell-resize"
      data-side={side}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onDoubleClick={() => resize(side)}
      onKeyDown={onKeyDown}
    />
  );
}

/** 左栏，内容跟着图标栏的当前项 */
export function Left({ label, children }: { label: string; children: ReactNode }) {
  const { ref, onKeyDown } = useDrawer('left');
  const [dragged, setDragged] = useState<number>();
  return (
    <>
      <nav
        ref={ref}
        className="shell-left"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ '--left-w': dragged === undefined ? undefined : `${dragged}rem` } as CSSProperties}
      >
        {children}
      </nav>
      <Separator side="left" onDrag={setDragged} />
    </>
  );
}

export function Main({ children }: { children: ReactNode }) {
  return <main className="shell-main">{children}</main>;
}

/** 右侧面板，只跟着会话出现 */
export function Aside({ label, children }: { label: string; children: ReactNode }) {
  const { ref, onKeyDown } = useDrawer('right');
  const [dragged, setDragged] = useState<number>();
  return (
    <>
      <Separator side="right" onDrag={setDragged} />
      <aside
        ref={ref}
        className="shell-right"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ '--right-w': dragged === undefined ? undefined : `${dragged}rem` } as CSSProperties}
      >
        {children}
      </aside>
    </>
  );
}

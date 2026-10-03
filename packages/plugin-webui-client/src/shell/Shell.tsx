import type { HostPanelTab } from '@aalis/api-webui';
import { MessagesSquare } from 'lucide-react';
import {
  createContext,
  type KeyboardEvent,
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
import { useConnection } from '../connection';
import { shortcutLabel, shortcutOf } from '../keys';
import { PinnedRail } from '../pages/Pinned';
import { pageAt, paths, routes } from '../routes';
import { readStored, writeStored } from '../storage';
import { ConnectionBar } from './ConnectionBar';
import { QuickSwitch } from './QuickSwitch';
import './Shell.css';

// 外壳：图标栏、左栏、主区、右侧面板，栏宽固定。左栏 64em 起、右侧面板 80em 起常驻，可收起，收起状态存本浏览器；
// 更窄时它们是覆盖式抽屉；48em 以下是手机，没有图标栏，按地址分三层逐级进入，每层占满一屏。
// 图标栏上方是「会话」，下面是 owner 固定的页面；打开着插件页面（/p/ 地址）时「会话」回到刚才的会话地址

type Side = 'left' | 'right';

const DOCKED: Record<Side, string> = { left: '(min-width: 64em)', right: '(min-width: 80em)' };
const PHONE = '(max-width: 47.99em)';

/** 两侧在常驻宽度下是否展开 */
type Panels = Record<Side, boolean>;

function storedPanels(): Panels {
  const stored = readStored('panels') as Partial<Panels> | undefined;
  return typeof stored?.left === 'boolean' && typeof stored.right === 'boolean'
    ? { left: stored.left, right: stored.right }
    : { left: true, right: true };
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
  const [panels, setPanels] = useState(storedPanels);
  const [drawer, setDrawer] = useState<Side>();
  const [searching, setSearching] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const { approvals, appName } = useConnection();

  /** 按一侧现在开着没有，定它接下来开不开 */
  const change = useCallback(
    (side: Side, decide: (open: boolean) => boolean) => {
      if (matchMedia(PHONE).matches) return;
      if (!matchMedia(DOCKED[side]).matches) {
        setDrawer(current => (decide(current === side) ? side : current === side ? undefined : current));
        return;
      }
      const open = decide(panels[side]);
      if (open === panels[side]) return;
      const next = { ...panels, [side]: open };
      setPanels(next);
      writeStored('panels', next);
    },
    [panels],
  );
  const toggle = useCallback((side: Side) => change(side, open => !open), [change]);

  const controls = useMemo<ShellControls>(
    () => ({
      drawer,
      toggle,
      reveal: side => change(side, () => true),
      closeDrawer: () => setDrawer(undefined),
      openSearch: () => setSearching(true),
    }),
    [drawer, toggle, change],
  );

  // 有推来的未结审批时，标签页标题前带上待处理数
  useEffect(() => {
    document.title = approvals.size > 0 ? `(${approvals.size}) ${appName}` : appName;
  }, [approvals, appName]);

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

  const onPage = pageAt(location.pathname) !== undefined;
  const lastSessions = useRef<string>(paths.home);
  useEffect(() => {
    if (!onPage) lastSessions.current = location.pathname + location.search;
  }, [onPage, location]);

  // 手机上用量从底部弹出，不另成一层；会话面板的标签与插件的会话面板是第三层
  const tab = matchPath(routes.sessionTab, location.pathname)?.params.tab;
  const panel = matchPath(routes.sessionPanel, location.pathname) !== null;
  const level =
    location.pathname === routes.home
      ? 1
      : panel || (tab !== undefined && tab !== ('usage' satisfies HostPanelTab))
        ? 3
        : 2;

  return (
    <Context.Provider value={controls}>
      <div
        className="shell"
        data-level={level}
        data-left={panels.left ? undefined : 'collapsed'}
        data-right={panels.right ? undefined : 'collapsed'}
        data-drawer={drawer}
      >
        <nav className="shell-rail" aria-label="图标栏">
          <Link
            to={onPage ? lastSessions.current : paths.home}
            className="shell-rail-item"
            aria-current={onPage ? undefined : 'page'}
            aria-label="会话"
            title={onPage ? '会话' : `会话（${shortcutLabel('toggleLeft')} 收起或展开左栏）`}
            onClick={event => {
              if (onPage) return;
              event.preventDefault();
              toggle('left');
            }}
          >
            <MessagesSquare aria-hidden />
            <span className="shell-rail-name" aria-hidden>
              会话
            </span>
          </Link>
          <PinnedRail />
        </nav>
        <ConnectionBar />
        <Outlet />
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

/** 左栏，内容跟着图标栏的当前项 */
export function Left({ label, children }: { label: string; children: ReactNode }) {
  const { ref, onKeyDown } = useDrawer('left');
  return (
    <nav ref={ref} className="shell-left" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
      {children}
    </nav>
  );
}

export function Main({ children }: { children: ReactNode }) {
  return <main className="shell-main">{children}</main>;
}

/** 右侧面板，只跟着会话出现 */
export function Aside({ label, children }: { label: string; children: ReactNode }) {
  const { ref, onKeyDown } = useDrawer('right');
  return (
    <aside ref={ref} className="shell-right" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
      {children}
    </aside>
  );
}

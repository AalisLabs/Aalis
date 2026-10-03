import type { LayoutOperation, PageRef, PanelTabRef, ThemeKind } from '@aalis/api-webui';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { downloadTheme, type ImportResult, type ThemeEntry, useAppearance } from '../appearance';
import { Badge } from '../components/Badge';
import { Block } from '../components/Block';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { useToast } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { pageName, refOf, sameRef, usePages } from '../pages/registry';
import { usePluginNames } from '../plugins/list';
import { hostTabTitle } from '../workbench/panel-tabs';

// 设置的「外观」：主题的选择（跟随系统时深浅各选一个），主题文件的导出与导入，快捷栏（图标栏上固定的页面）与会话面板
// 标签的顺序与开关。主题的选择存本浏览器；快捷栏与面板标签是布局记录，跟着 owner 走

const KINDS: Record<ThemeKind, string> = { dark: '深色', light: '浅色' };

export function AppearanceSection() {
  return (
    <div className="page-screen settings-screen">
      <Themes />
      <ThemeFiles />
      <PinnedOrder />
      <PanelTabsOrder />
    </div>
  );
}

/** 主题出自哪：内置、导入，或提供它的插件 */
function useOrigin(): (entry: ThemeEntry) => string | undefined {
  const { instances } = usePluginNames();
  return ({ origin }) =>
    origin.kind === 'builtin'
      ? undefined
      : origin.kind === 'imported'
        ? '导入'
        : (instances.get(origin.instance)?.label ?? origin.instance);
}

function Themes() {
  const { themes, choice, shown, choose, pluginError } = useAppearance();
  const originOf = useOrigin();
  const labelOf = (entry: ThemeEntry) => {
    const origin = originOf(entry);
    return origin ? `${entry.theme.name}（${origin}）` : entry.theme.name;
  };
  const { current } = shown;
  /** 打开跟随时正在用的主题留在它那一种深浅上；关掉时固定成正在用的 */
  const follow = (on: boolean) => {
    if (on) {
      const slots = { dark: shown.dark.id, light: shown.light.id };
      slots[current.theme.kind] = current.id;
      choose({ follow: true, ...slots });
    } else {
      choose({ follow: false, theme: current.id, kind: current.theme.kind });
    }
  };
  return (
    <Block title="主题">
      <div className="settings-field">
        <span aria-hidden>跟随系统</span>
        <Toggle label="跟随系统" checked={choice.follow} onChange={follow} />
      </div>
      {choice.follow ? (
        <>
          <ThemeSelect
            label="深色用"
            themes={themes.filter(entry => entry.theme.kind === 'dark')}
            value={shown.dark.id}
            labelOf={labelOf}
            onChange={entry => choose({ ...choice, dark: entry.id })}
          />
          <ThemeSelect
            label="浅色用"
            themes={themes.filter(entry => entry.theme.kind === 'light')}
            value={shown.light.id}
            labelOf={labelOf}
            onChange={entry => choose({ ...choice, light: entry.id })}
          />
        </>
      ) : (
        <ThemeSelect
          label="主题"
          themes={themes}
          value={current.id}
          labelOf={labelOf}
          onChange={entry => choose({ follow: false, theme: entry.id, kind: entry.theme.kind })}
        />
      )}
      <p className="settings-note">主题的选择与导入的主题存在这个浏览器里。</p>
      {pluginError && (
        <p className="settings-note" role="alert">
          插件提供的主题没取到：{pluginError.message}
        </p>
      )}
    </Block>
  );
}

interface ThemeSelectProps {
  label: string;
  themes: readonly ThemeEntry[];
  value: string;
  labelOf(entry: ThemeEntry): string;
  onChange(entry: ThemeEntry): void;
}

function ThemeSelect({ label, themes, value, labelOf, onChange }: ThemeSelectProps) {
  const id = useId();
  return (
    <div className="settings-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={event => onChange(themes.find(entry => entry.id === event.target.value) as ThemeEntry)}
      >
        {themes.map(entry => (
          <option key={entry.id} value={entry.id}>
            {labelOf(entry)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ThemeFiles() {
  const { themes, importTheme, removeImported } = useAppearance();
  const originOf = useOrigin();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportResult>();
  return (
    <Block title="主题文件">
      <p className="settings-note">任何主题都能导出成主题文件，照着改了再导入；插件也能提供主题。</p>
      <ul className="settings-list" aria-label="主题文件">
        {themes.map(entry => (
          <li key={entry.id}>
            <span className="settings-list-name">
              {entry.theme.name}
              <span className="settings-list-meta">{`${KINDS[entry.theme.kind]} · ${originOf(entry) ?? '内置'}`}</span>
            </span>
            <span className="settings-list-actions">
              {entry.origin.kind === 'imported' && (
                <Button variant="text" danger onClick={() => removeImported(entry.id)}>
                  移除
                </Button>
              )}
              <Button variant="text" onClick={() => downloadTheme(entry.theme)}>
                导出
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="导入主题文件"
        onChange={async event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) setResult(await importTheme(file));
        }}
      />
      <div className="settings-actions">
        <Button onClick={() => input.current?.click()}>导入主题文件</Button>
      </div>
      {result?.ok === true && (
        <div className="settings-result" role="status">
          <p>{`已导入「${result.entry.theme.name}」${result.replaced ? '，替换了同名的主题' : ''}。`}</p>
          {result.issues.length > 0 && (
            <>
              <p>这几处对比度不够，仍可使用：</p>
              <ul>
                {result.issues.map(issue => (
                  <li key={issue.pair}>{`${issue.pair} ${issue.ratio}（要 ${issue.minimum}）`}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {result?.ok === false && (
        <div className="settings-result" role="alert">
          <p>没有导入：</p>
          <ul>
            {result.errors.map(error => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
    </Block>
  );
}

/** 改布局记录，写不进去时用 Toast 报 */
function useLayoutChange() {
  const { changeLayout } = usePages();
  const toast = useToast();
  return (operation: LayoutOperation, label: string) =>
    void changeLayout(operation).catch((err: Error) => toast({ kind: 'danger', text: `${label}失败：${err.message}` }));
}

/** 所属插件没启用的页面：只知道实例与页面 key */
function useMissingName(): (ref: PageRef) => string {
  const { instances } = usePluginNames();
  return ref => `${instances.get(ref.instance)?.label ?? ref.instance} · ${ref.pageKey}`;
}

interface OrderRowProps {
  name: string;
  /** 所属插件没启用 */
  missing?: boolean;
  first: boolean;
  last: boolean;
  up(): void;
  down(): void;
  /** 只有部分行才有的操作，放在上移之前，各行共有的操作就能上下对齐 */
  extra?: ReactNode;
  /** 各行都有的操作，接在下移后面 */
  children: ReactNode;
}

/** 可以排顺序的一行：名字（没启用的标出来）、上移、下移与别的操作 */
function OrderRow({ name, missing, first, last, up, down, extra, children }: OrderRowProps) {
  return (
    <li>
      <span className="settings-list-name">
        {name}
        {missing && <Badge>未启用</Badge>}
      </span>
      <span className="settings-list-actions">
        {extra}
        <IconButton icon={ArrowUp} label="上移" disabled={first} onClick={up} />
        <IconButton icon={ArrowDown} label="下移" disabled={last} onClick={down} />
        {children}
      </span>
    </li>
  );
}

function PinnedOrder() {
  const { pages, layout, layoutError } = usePages();
  const change = useLayoutChange();
  const missingName = useMissingName();
  return (
    <Block title="快捷栏">
      <p className="settings-note">图标栏上固定的页面。插件页面的标题栏里可以固定。</p>
      {layoutError && !layout && (
        <p className="settings-note" role="alert">
          布局记录没取到：{layoutError.message}
        </p>
      )}
      {layout && layout.pinned.length > 0 && (
        <ul className="settings-list" aria-label="快捷栏">
          {layout.pinned.map((ref, index) => {
            const page = pages?.find(view => view.placement === 'plugin' && sameRef(ref)(refOf(view)));
            return (
              <OrderRow
                key={`${ref.instance}\n${ref.pageKey}`}
                name={page ? pageName(page) : missingName(ref)}
                missing={pages !== undefined && !page}
                first={index === 0}
                last={index === layout.pinned.length - 1}
                up={() => change({ op: 'move-up', page: ref }, '上移')}
                down={() => change({ op: 'move-down', page: ref }, '下移')}
              >
                <Button variant="text" onClick={() => change({ op: 'unpin', page: ref }, '取消固定')}>
                  取消固定
                </Button>
              </OrderRow>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

const tabKey = (tab: PanelTabRef) => ('host' in tab ? tab.host : `${tab.instance}\n${tab.pageKey}`);

function PanelTabsOrder() {
  const { pages, layout, layoutError } = usePages();
  const change = useLayoutChange();
  const missingName = useMissingName();
  return (
    <Block title="会话面板标签">
      <p className="settings-note">
        会话右侧面板里的标签。隐藏的在面板的「+」里；插件的标签可以移出，下次从「+」打开时排在最后。
      </p>
      {layoutError && !layout && (
        <p className="settings-note" role="alert">
          布局记录没取到：{layoutError.message}
        </p>
      )}
      {layout && (
        <ul className="settings-list" aria-label="会话面板标签">
          {layout.panelTabs.map(({ tab, open }, index) => {
            const page =
              'host' in tab
                ? undefined
                : pages?.find(view => view.placement === 'session' && sameRef(tab)(refOf(view)));
            const name = 'host' in tab ? hostTabTitle(tab.host) : page ? pageName(page) : missingName(tab);
            if (name === undefined) return null;
            const missing = !('host' in tab) && pages !== undefined && !page;
            return (
              <OrderRow
                key={tabKey(tab)}
                name={name}
                missing={missing}
                first={index === 0}
                last={index === layout.panelTabs.length - 1}
                up={() => change({ op: 'tab-up', tab }, '上移')}
                down={() => change({ op: 'tab-down', tab }, '下移')}
                extra={
                  !('host' in tab) && (
                    <Button variant="text" onClick={() => change({ op: 'remove-tab', tab }, '移出')}>
                      移出
                    </Button>
                  )
                }
              >
                <Toggle
                  label={`显示${name}`}
                  checked={open}
                  disabled={missing && !open}
                  onChange={show => change({ op: show ? 'open-tab' : 'close-tab', tab }, show ? '显示' : '隐藏')}
                />
              </OrderRow>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

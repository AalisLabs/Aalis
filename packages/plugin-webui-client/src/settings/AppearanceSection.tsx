import type { LayoutOperation, PageRef, PanelTabRef, ThemeKind } from '@aalis/api-webui';
import type { TextRef } from '@aalis/schema-i18n';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { downloadTheme, type ImportResult, type ThemeEntry, useAppearance } from '../appearance';
import { Badge } from '../components/Badge';
import { Block } from '../components/Block';
import { Button } from '../components/Button';
import { FetchError } from '../components/FetchError';
import { IconButton } from '../components/IconButton';
import { Select } from '../components/Select';
import { useToast } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { tr } from '../language';
import { pageName, refOf, sameRef, usePages } from '../pages/registry';
import { useHost, usePluginNames } from '../plugins/list';
import { t } from '../texts';
import { hostTabTitle } from '../workbench/panel-tabs';

// 设置的「外观」：主题的选择（跟随系统时深浅各选一个），主题文件的导出与导入，快捷栏（图标栏上固定的页面）与会话面板
// 标签的顺序与开关。主题的选择存本浏览器；快捷栏与面板标签是布局记录，跟着 owner 走

const KINDS: Record<ThemeKind, TextRef> = { dark: t('themeDark'), light: t('themeLight') };

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
        ? tr('themeOriginImported')
        : (instances.get(origin.instance)?.label ?? origin.instance);
}

function Themes() {
  const { themes, choice, shown, choose, pluginError, retryPluginThemes } = useAppearance();
  const host = useHost();
  const originOf = useOrigin();
  const labelOf = (entry: ThemeEntry) => {
    const origin = originOf(entry);
    return origin ? tr('themeWithOrigin', { name: entry.theme.name, origin }) : entry.theme.name;
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
    <Block title={tr('theme')}>
      <div className="settings-field">
        <span aria-hidden>{tr('themeFollowSystem')}</span>
        <Toggle label={tr('themeFollowSystem')} checked={choice.follow} onChange={follow} />
      </div>
      {choice.follow ? (
        <>
          <ThemeSelect
            label={tr('themeForDark')}
            themes={themes.filter(entry => entry.theme.kind === 'dark')}
            value={shown.dark.id}
            labelOf={labelOf}
            onChange={entry => choose({ ...choice, dark: entry.id })}
          />
          <ThemeSelect
            label={tr('themeForLight')}
            themes={themes.filter(entry => entry.theme.kind === 'light')}
            value={shown.light.id}
            labelOf={labelOf}
            onChange={entry => choose({ ...choice, light: entry.id })}
          />
        </>
      ) : (
        <ThemeSelect
          label={tr('theme')}
          themes={themes}
          value={current.id}
          labelOf={labelOf}
          onChange={entry => choose({ follow: false, theme: entry.id, kind: entry.theme.kind })}
        />
      )}
      <p className="settings-note">{tr('themeStoredNote')}</p>
      {pluginError && (
        <FetchError what={tr('pluginThemes')} error={pluginError} retry={retryPluginThemes} inline source={host} />
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
      <Select
        id={id}
        value={value}
        options={themes.map(entry => ({ value: entry.id, label: labelOf(entry) }))}
        onChange={chosen => onChange(themes.find(entry => entry.id === chosen) as ThemeEntry)}
      />
    </div>
  );
}

function ThemeFiles() {
  const { themes, importTheme, removeImported } = useAppearance();
  const originOf = useOrigin();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportResult>();
  return (
    <Block title={tr('themeFiles')}>
      <p className="settings-note">{tr('themeFilesNote')}</p>
      <ul className="settings-list" aria-label={tr('themeFiles')}>
        {themes.map(entry => (
          <li key={entry.id}>
            <span className="settings-list-name">
              {entry.theme.name}
              <span className="settings-list-meta">
                {tr('themeMeta', { kind: KINDS[entry.theme.kind], origin: originOf(entry) ?? tr('themeBuiltin') })}
              </span>
            </span>
            <span className="settings-list-actions">
              {entry.origin.kind === 'imported' && (
                <Button variant="text" danger onClick={() => removeImported(entry.id)}>
                  {tr('remove')}
                </Button>
              )}
              <Button variant="text" onClick={() => downloadTheme(entry.theme)}>
                {tr('themeExport')}
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
        aria-label={tr('themeImport')}
        onChange={async event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) setResult(await importTheme(file));
        }}
      />
      <div className="settings-actions">
        <Button onClick={() => input.current?.click()}>{tr('themeImport')}</Button>
      </div>
      {result?.ok === true && (
        <div className="settings-result" role="status">
          <p>{tr(result.replaced ? 'themeImportReplaced' : 'themeImportDone', { name: result.entry.theme.name })}</p>
          {result.issues.length > 0 && (
            <>
              <p>{tr('themeContrastIssues')}</p>
              <ul>
                {result.issues.map(issue => (
                  <li key={issue.pair.source}>
                    {tr('themeContrastIssue', { pair: issue.pair, ratio: issue.ratio, minimum: issue.minimum })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {result?.ok === false && (
        <div className="settings-result" role="alert">
          <p>{tr('themeImportFailed')}</p>
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

/** 改布局记录，写不进去时用 Toast 报；label 是按钮上的字，也是 Toast 里的动作名 */
function useLayoutChange() {
  const { changeLayout } = usePages();
  const toast = useToast();
  const host = useHost();
  return (operation: LayoutOperation, label: string) =>
    void changeLayout(operation).catch((err: Error) =>
      toast({ kind: 'danger', text: tr('actionFailed', { action: label, error: err.message }), source: host }),
    );
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
        {missing && <Badge>{tr('notEnabled')}</Badge>}
      </span>
      <span className="settings-list-actions">
        {extra}
        <IconButton icon={ArrowUp} label={tr('moveUp')} disabled={first} onClick={up} />
        <IconButton icon={ArrowDown} label={tr('moveDown')} disabled={last} onClick={down} />
        {children}
      </span>
    </li>
  );
}

function PinnedOrder() {
  const { pages, layout, layoutError, retry } = usePages();
  const host = useHost();
  const change = useLayoutChange();
  const missingName = useMissingName();
  return (
    <Block title={tr('pinnedBar')}>
      <p className="settings-note">{tr('pinnedNote')}</p>
      {layoutError && (
        <FetchError
          what={tr('layoutRecord')}
          error={layoutError}
          retry={retry}
          stale={layout !== undefined}
          inline
          source={host}
        />
      )}
      {layout && layout.pinned.length > 0 && (
        <ul className="settings-list" aria-label={tr('pinnedBar')}>
          {layout.pinned.map((ref, index) => {
            const page = pages?.find(view => view.placement === 'plugin' && sameRef(ref)(refOf(view)));
            return (
              <OrderRow
                key={`${ref.instance}\n${ref.pageKey}`}
                name={page ? pageName(page) : missingName(ref)}
                missing={pages !== undefined && !page}
                first={index === 0}
                last={index === layout.pinned.length - 1}
                up={() => change({ op: 'move-up', page: ref }, tr('moveUp'))}
                down={() => change({ op: 'move-down', page: ref }, tr('moveDown'))}
              >
                <Button variant="text" onClick={() => change({ op: 'unpin', page: ref }, tr('unpin'))}>
                  {tr('unpin')}
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
  const { pages, layout, layoutError, retry } = usePages();
  const host = useHost();
  const change = useLayoutChange();
  const missingName = useMissingName();
  return (
    <Block title={tr('panelTabs')}>
      <p className="settings-note">{tr('panelTabsNote')}</p>
      {layoutError && (
        <FetchError
          what={tr('layoutRecord')}
          error={layoutError}
          retry={retry}
          stale={layout !== undefined}
          inline
          source={host}
        />
      )}
      {layout && (
        <ul className="settings-list" aria-label={tr('panelTabs')}>
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
                up={() => change({ op: 'tab-up', tab }, tr('moveUp'))}
                down={() => change({ op: 'tab-down', tab }, tr('moveDown'))}
                extra={
                  !('host' in tab) && (
                    <Button variant="text" onClick={() => change({ op: 'remove-tab', tab }, tr('moveOut'))}>
                      {tr('moveOut')}
                    </Button>
                  )
                }
              >
                <Toggle
                  label={tr('showTab', { name })}
                  checked={open}
                  disabled={missing && !open}
                  onChange={show => change({ op: show ? 'open-tab' : 'close-tab', tab }, tr(show ? 'show' : 'hide'))}
                />
              </OrderRow>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

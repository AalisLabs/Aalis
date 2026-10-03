import {
  BUILTIN_THEMES,
  type ContrastIssue,
  DEFAULT_THEMES,
  type PluginTheme,
  parseTheme,
  THEME_FILE_FORMAT,
  THEME_FILE_VERSION,
  THEME_TOKENS,
  type Theme,
  type ThemeFile,
  type ThemeKind,
  type ThemeToken,
  themeContrastIssues,
} from '@aalis/api-webui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
} from 'react';
import { useConnection } from './connection';
import { isRecord, useJson } from './rest';
import { readStored, writeStored } from './storage';

// 外观：主题的选择、导入的主题与插件经贡献点提供的主题。选择与导入的主题存本浏览器（首帧主题脚本读 appearance）；
// 插件提供的主题取自 GET /api/themes，插件启停、管理连接重连后重取。正在用的主题不在了（导入的移除、插件停用）时用
// 同深浅的偏中性，回来了就回到它。内置主题的颜色在页面头部的规则里，只换 data-theme；导入与插件提供的另把令牌逐个
// 写进根元素的内联样式，首帧脚本照存着的令牌做同样的事

/** 导入的主题文件最多这么大 */
const THEME_FILE_MAX_BYTES = 16 * 1024;

export type ThemeOrigin = { kind: 'builtin' } | { kind: 'imported' } | { kind: 'plugin'; instance: string };

export interface ThemeEntry {
  id: string;
  theme: Theme;
  origin: ThemeOrigin;
}

/** 跟随系统时深浅各选一个；不跟随时选一个，记下它的深浅，它不在了时回到同深浅的偏中性 */
type Choice = { follow: true; dark: string; light: string } | { follow: false; theme: string; kind: ThemeKind };

export type ImportResult =
  | { ok: true; entry: ThemeEntry; replaced: boolean; issues: ContrastIssue[] }
  | { ok: false; errors: string[] };

const DEFAULT_CHOICE: Choice = { follow: true, ...DEFAULT_THEMES };

const BUILTIN: readonly ThemeEntry[] = Object.entries(BUILTIN_THEMES).map(([id, file]) => ({
  id,
  theme: { name: file.name, kind: file.kind as ThemeKind, colors: file.colors as Record<ThemeToken, string> },
  origin: { kind: 'builtin' },
}));

const builtinOf = (kind: ThemeKind) => BUILTIN.find(entry => entry.id === DEFAULT_THEMES[kind]) as ThemeEntry;

const importedId = (theme: Theme) => `imported:${theme.kind}:${theme.name}`;

const fileOf = (theme: Theme): ThemeFile => ({
  format: THEME_FILE_FORMAT,
  version: THEME_FILE_VERSION,
  name: theme.name,
  kind: theme.kind,
  colors: theme.colors,
});

/** 存着的主题按主题文件的格式校验：认不出的丢掉 */
function themeOf(value: unknown): Theme | undefined {
  const parsed = isRecord(value)
    ? parseTheme({ ...value, format: THEME_FILE_FORMAT, version: THEME_FILE_VERSION })
    : undefined;
  return parsed?.ok ? parsed.theme : undefined;
}

function storedChoice(): Choice {
  const stored = readStored('appearance');
  if (!isRecord(stored)) return DEFAULT_CHOICE;
  if (stored.follow === false && typeof stored.theme === 'string') {
    const builtin = BUILTIN.find(entry => entry.id === stored.theme);
    const kind = stored.kind === 'dark' || stored.kind === 'light' ? stored.kind : (builtin?.theme.kind ?? 'dark');
    return { follow: false, theme: stored.theme, kind };
  }
  const slot = (kind: ThemeKind) =>
    typeof stored[kind] === 'string' ? (stored[kind] as string) : DEFAULT_THEMES[kind];
  return { follow: true, dark: slot('dark'), light: slot('light') };
}

/** 上次存下的插件主题：插件主题取回之前先用它们，页面不会先闪成偏中性 */
function storedPalettes(): ThemeEntry[] {
  const palettes = (readStored('appearance') as { palettes?: unknown } | undefined)?.palettes;
  if (!isRecord(palettes)) return [];
  return Object.entries(palettes).flatMap(([id, value]) => {
    const theme = id.startsWith('plugin:') ? themeOf(value) : undefined;
    // id 是 plugin: 加贡献点的全局键（<插件实例 id>/<局部 id>）
    return theme
      ? [{ id, theme, origin: { kind: 'plugin', instance: id.slice('plugin:'.length, id.lastIndexOf('/')) } }]
      : [];
  });
}

function storedImports(): ThemeEntry[] {
  const stored = readStored('themes');
  return (Array.isArray(stored) ? stored : []).flatMap(file => {
    const parsed = parseTheme(file);
    return parsed.ok ? [{ id: importedId(parsed.theme), theme: parsed.theme, origin: { kind: 'imported' } }] : [];
  });
}

function parsePluginThemes(body: unknown): ThemeEntry[] {
  if (!isRecord(body) || !Array.isArray(body.themes)) throw new Error('插件主题的回应不是预期的形状');
  return (body.themes as PluginTheme[]).map(({ id, instance, theme }) => ({
    id: `plugin:${id}`,
    theme,
    origin: { kind: 'plugin', instance },
  }));
}

function useSystemDark(): boolean {
  return useSyncExternalStore(
    listener => {
      const query = matchMedia('(prefers-color-scheme: dark)');
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
}

/** 换上一个主题：内置的只换 data-theme，其余另把令牌与深浅逐个写进根元素的内联样式 */
function applyTheme({ id, theme, origin }: ThemeEntry): void {
  const root = document.documentElement;
  for (const token of THEME_TOKENS) root.style.removeProperty(token);
  root.style.removeProperty('color-scheme');
  if (origin.kind !== 'builtin') {
    for (const token of THEME_TOKENS) root.style.setProperty(token, theme.colors[token]);
    root.style.setProperty('color-scheme', theme.kind);
  }
  root.dataset.theme = id;
}

/** 把主题导出成主题文件，经下载链接交给浏览器 */
export function downloadTheme(theme: Theme): void {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(fileOf(theme), null, 2)}\n`], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${theme.name.replace(/[\\/:*?"<>|]/g, '-')}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  // 立即撤销时有的浏览器（WebKit）来不及开始下载：留一分钟
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface Appearance {
  /** 可选的主题：内置的、导入的、插件提供的 */
  themes: readonly ThemeEntry[];
  choice: Choice;
  /** 实际用着的：选中的不在了时是同深浅的偏中性 */
  shown: { dark: ThemeEntry; light: ThemeEntry; current: ThemeEntry };
  /** 插件主题最近一次没取到的原因 */
  pluginError?: Error;
  choose(choice: Choice): void;
  importTheme(file: File): Promise<ImportResult>;
  removeImported(id: string): void;
}

const Context = createContext<Appearance | undefined>(undefined);

export function useAppearance(): Appearance {
  const appearance = useContext(Context);
  if (!appearance) throw new Error('只能在 AppearanceProvider 里取外观');
  return appearance;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { admin } = useConnection();
  const [choice, setChoice] = useState(storedChoice);
  const [imported, setImported] = useState(storedImports);
  const [cached] = useState(storedPalettes);
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const plugin = useJson('/api/themes', parsePluginThemes, version);
  const systemDark = useSystemDark();

  useEffect(() => {
    const offs = [admin.on('plugins.changed', refetch), admin.onReconnect(refetch)];
    return () => {
      for (const off of offs) off();
    };
  }, [admin]);

  const themes = useMemo(
    () => [...BUILTIN, ...imported, ...(plugin.value ?? cached)],
    [imported, plugin.value, cached],
  );
  const find = useCallback(
    (id: string, kind: ThemeKind) =>
      themes.find(entry => entry.id === id && entry.theme.kind === kind) ?? builtinOf(kind),
    [themes],
  );
  const shown = useMemo(() => {
    const dark = find(choice.follow ? choice.dark : DEFAULT_THEMES.dark, 'dark');
    const light = find(choice.follow ? choice.light : DEFAULT_THEMES.light, 'light');
    const current = choice.follow ? (systemDark ? dark : light) : find(choice.theme, choice.kind);
    return { dark, light, current };
  }, [choice, find, systemDark]);

  const current = shown.current;
  useLayoutEffect(() => applyTheme(current), [current]);

  // 首帧脚本读的：选择，以及选中的、此刻在的非内置主题的令牌
  useEffect(() => {
    const chosen = choice.follow ? [shown.dark, shown.light] : [shown.current];
    const palettes = Object.fromEntries(
      chosen.filter(entry => entry.origin.kind !== 'builtin').map(entry => [entry.id, entry.theme]),
    );
    writeStored('appearance', { ...choice, palettes });
  }, [choice, shown]);

  const saveImports = useCallback((next: ThemeEntry[]) => {
    setImported(next);
    writeStored(
      'themes',
      next.map(entry => fileOf(entry.theme)),
    );
  }, []);

  const importTheme = useCallback(
    async (file: File): Promise<ImportResult> => {
      if (file.size > THEME_FILE_MAX_BYTES) {
        return { ok: false, errors: [`文件超过 ${THEME_FILE_MAX_BYTES / 1024} KB`] };
      }
      let value: unknown;
      try {
        value = JSON.parse(await file.text());
      } catch {
        return { ok: false, errors: ['不是 JSON 文件'] };
      }
      const parsed = parseTheme(value);
      if (!parsed.ok) return parsed;
      const entry: ThemeEntry = { id: importedId(parsed.theme), theme: parsed.theme, origin: { kind: 'imported' } };
      const replaced = imported.some(existing => existing.id === entry.id);
      saveImports([...imported.filter(existing => existing.id !== entry.id), entry]);
      return { ok: true, entry, replaced, issues: themeContrastIssues(parsed.theme) };
    },
    [imported, saveImports],
  );

  const removeImported = useCallback(
    (id: string) => saveImports(imported.filter(entry => entry.id !== id)),
    [imported, saveImports],
  );

  const value = useMemo<Appearance>(
    () => ({
      themes,
      choice,
      shown,
      pluginError: plugin.error,
      choose: setChoice,
      importTheme,
      removeImported,
    }),
    [themes, choice, shown, plugin.error, importTheme, removeImported],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

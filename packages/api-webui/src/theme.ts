// ----- 主题 -----
//
// 一个主题是名字、种类（深或浅）与一套颜色令牌值，只改颜色，不改间距、圆角、字号与布局。主题文件是可交换的 JSON：
// 格式名、格式版本、名字、种类与颜色令牌表，没有别的内容。内置主题就是随包带的这种文件，第三方主题照着改了再导入，
// 插件提供的主题也只交同一种数据，三者都经 parseTheme 校验。
//
// 令牌名是公开契约：主题只能写 THEME_TOKENS 里的名字，界面的样式只引用这些名字。改名会打破已有的主题，
// 所以按格式版本迁移，迁不了的拒收并说明。
//
// 插件经贡献点 `webui:theme` 提供主题（ThemeContribution），webui-server 经 GET /api/themes 列出校验过的，
// 插件停用就随之撤回；设置「外观」的主题选择里与内置、导入的主题并列。

import type {} from '@aalis/api-contributions'; // declaration merging 锚点（下方 ContributionPointMap 增强）
import aalisDark from './themes/aalis-dark.json' with { type: 'json' };
import aalisLight from './themes/aalis-light.json' with { type: 'json' };
import brandDark from './themes/brand-dark.json' with { type: 'json' };
import brandLight from './themes/brand-light.json' with { type: 'json' };
import calmDark from './themes/calm-dark.json' with { type: 'json' };
import calmLight from './themes/calm-light.json' with { type: 'json' };
import neutralDark from './themes/neutral-dark.json' with { type: 'json' };
import neutralLight from './themes/neutral-light.json' with { type: 'json' };

/** 主题文件的格式名 */
export const THEME_FILE_FORMAT = 'aalis-theme';
/** 主题文件的格式版本：令牌表改名时加一，旧版本的文件按版本迁移 */
export const THEME_FILE_VERSION = 1;

/** 名字最多这么多个字，按纯文本显示 */
const THEME_NAME_MAX_LENGTH = 40;

/**
 * 颜色令牌表，名字即 CSS 自定义属性名。fill 系列是半透明的叠加底，放在任何底色上都成立；
 * 图表色给关系图等分类着色，语法色给代码高亮
 */
export const THEME_TOKENS = [
  /** 主区：会话、页面 */
  '--color-bg',
  /** 左栏、右侧面板 */
  '--color-bg-side',
  /** 图标栏 */
  '--color-bg-rail',
  /** 浮在内容上的：菜单、弹出层、对话框、Toast */
  '--color-surface-raised',
  /** 悬停底、代码块、工具输出 */
  '--color-fill-1',
  /** 选中行、用户消息、次要按钮 */
  '--color-fill-2',
  /** 次要按钮的悬停与按下 */
  '--color-fill-3',
  /** 分隔线：栏与栏之间、头部与正文之间、表格行线 */
  '--color-border',
  /** 输入框、复选框的外框 */
  '--color-border-control',
  /** 正文、标题 */
  '--color-text',
  /** 次要：说明、标签、工具行、图标 */
  '--color-text-2',
  /** 弱化：时间、占位符、元信息 */
  '--color-text-3',
  /** 不可用 */
  '--color-text-disabled',
  /** 主按钮底、开关打开、选中标签的下划线 */
  '--color-accent',
  /** 主按钮悬停 */
  '--color-accent-hover',
  /** 主按钮与危险按钮上的字 */
  '--color-on-accent',
  /** 链接、强调字 */
  '--color-accent-text',
  /** 未读点、选中标签的浅底 */
  '--color-accent-subtle',
  /** 焦点环 */
  '--color-focus',
  /** 金色标记：需要处理的圆点、当前项的指示条 */
  '--color-mark',
  /** 危险按钮底（只在确认对话框里用） */
  '--color-danger',
  /** 危险按钮悬停 */
  '--color-danger-hover',
  /** 出错的文字与图标 */
  '--color-danger-text',
  /** 出错条的浅底 */
  '--color-danger-subtle',
  /** 需要处理、警告的文字 */
  '--color-warning-text',
  /** 需要处理的浅底 */
  '--color-warning-subtle',
  /** 成功的文字 */
  '--color-success-text',
  /** 成功的浅底 */
  '--color-success-subtle',
  /** 对话框后面的遮罩 */
  '--color-scrim',
  /** 浮层的投影 */
  '--color-shadow',
  '--color-chart-1',
  '--color-chart-2',
  '--color-chart-3',
  '--color-chart-4',
  '--color-chart-5',
  '--color-chart-6',
  '--color-syntax-keyword',
  '--color-syntax-string',
  '--color-syntax-number',
  '--color-syntax-comment',
  '--color-syntax-function',
  '--color-syntax-type',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeKind = 'dark' | 'light';

/** 主题文件：没写的令牌按同种类的偏中性主题补 */
export interface ThemeFile {
  format: typeof THEME_FILE_FORMAT;
  version: typeof THEME_FILE_VERSION;
  name: string;
  kind: ThemeKind;
  colors: Partial<Record<ThemeToken, string>>;
}

/** 校验过的主题：每个令牌都有值 */
export interface Theme {
  name: string;
  kind: ThemeKind;
  colors: Record<ThemeToken, string>;
}

export type ThemeParseResult = { ok: true; theme: Theme } | { ok: false; errors: string[] };

/**
 * `webui:theme` 贡献点的 spec：插件交一份主题文件，经 `contributions.contribute('webui:theme', { id, theme })` 登记，
 * 随激活撤回。id 是局部名，与插件实例 id 合成全局键。主题只是数据，与导入的主题文件走同一套校验（parseTheme），
 * 不合格式的不列出，webui-server 记一条告警
 */
export interface ThemeContribution {
  id: string;
  theme: ThemeFile;
}

declare module '@aalis/api-contributions' {
  interface ContributionPointMap {
    'webui:theme': ThemeContribution;
  }
}

/** GET /api/themes 的一项：贡献点的全局键（`<插件实例 id>/<局部 id>`）、提供它的插件实例与校验过的主题 */
export interface PluginTheme {
  id: string;
  instance: string;
  theme: Theme;
}

/** GET /api/themes：插件此刻提供的主题，按全局键排 */
export interface PluginThemesResponse {
  themes: PluginTheme[];
}

/** 内置主题：随包带的主题文件，键是主题 id（配色名加种类） */
export const BUILTIN_THEMES = {
  'calm-dark': calmDark,
  'calm-light': calmLight,
  'aalis-dark': aalisDark,
  'aalis-light': aalisLight,
  'brand-dark': brandDark,
  'brand-light': brandLight,
  'neutral-dark': neutralDark,
  'neutral-light': neutralLight,
};
export type BuiltinThemeId = keyof typeof BUILTIN_THEMES;

/** 跟随系统时默认的深色与浅色主题，也是补齐缺失令牌的来源 */
export const DEFAULT_THEMES: Readonly<Record<ThemeKind, BuiltinThemeId>> = { dark: 'calm-dark', light: 'calm-light' };

const TOKEN_SET: ReadonlySet<string> = new Set(THEME_TOKENS);
const FILE_FIELDS = new Set(['format', 'version', 'name', 'kind', 'colors']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 校验一份主题文件（已按 JSON 解析）：不合格式的列出全部原因 */
export function parseTheme(value: unknown): ThemeParseResult {
  if (!isRecord(value)) return { ok: false, errors: ['主题文件应是一个 JSON 对象'] };
  if (value.format !== THEME_FILE_FORMAT) return { ok: false, errors: [`格式名应为 ${THEME_FILE_FORMAT}`] };
  if (value.version !== THEME_FILE_VERSION) {
    return { ok: false, errors: [`格式版本 ${String(value.version)} 不认识，只认 ${THEME_FILE_VERSION}`] };
  }
  const errors: string[] = [];
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name === '' || [...name].length > THEME_NAME_MAX_LENGTH) {
    errors.push(`名字应是 1 到 ${THEME_NAME_MAX_LENGTH} 个字的文本`);
  }
  if (value.kind !== 'dark' && value.kind !== 'light') errors.push('种类应为 dark 或 light');
  for (const key of Object.keys(value)) if (!FILE_FIELDS.has(key)) errors.push(`多余的字段：${key}`);
  if (!isRecord(value.colors)) {
    errors.push('colors 应是一个对象');
    return { ok: false, errors };
  }
  for (const [token, color] of Object.entries(value.colors)) {
    if (!TOKEN_SET.has(token)) errors.push(`${token} 不在令牌表里`);
    else if (typeof color !== 'string' || !parseColor(color)) errors.push(`${token} 的值不是颜色：${String(color)}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const kind = value.kind as ThemeKind;
  const base: Record<ThemeToken, string> = BUILTIN_THEMES[DEFAULT_THEMES[kind]].colors;
  return {
    ok: true,
    theme: { name, kind, colors: { ...base, ...(value.colors as Partial<Record<ThemeToken, string>>) } },
  };
}

// ----- 对比度 -----

/** 一处前景落在底色上的组合；底色从下往上叠，半透明的一层先叠到下层再算 */
interface ContrastPair {
  pair: string;
  foreground: ThemeToken;
  background: readonly ThemeToken[];
  minimum: number;
}

/** 文字要达到的对比度 */
const TEXT = 4.5;
/** 焦点环、输入框外框、图标、标记这类非文字元素要达到的对比度 */
const NON_TEXT = 3;

const pair = (name: string, foreground: ThemeToken, background: ThemeToken[], minimum: number): ContrastPair => ({
  pair: name,
  foreground,
  background,
  minimum,
});

const SYNTAX_PAIRS = (
  [
    ['关键字', '--color-syntax-keyword'],
    ['字符串', '--color-syntax-string'],
    ['数字', '--color-syntax-number'],
    ['注释', '--color-syntax-comment'],
    ['函数名', '--color-syntax-function'],
    ['类型', '--color-syntax-type'],
  ] as const
).map(([name, token]) => pair(`代码${name} / 代码块`, token, ['--color-bg', '--color-fill-1'], TEXT));

const CHART_PAIRS = ([1, 2, 3, 4, 5, 6] as const).map(n =>
  pair(`图表色 ${n} / 主区`, `--color-chart-${n}`, ['--color-bg'], NON_TEXT),
);

/** 主题要过的全部组合：导入主题与内置主题的测试用同一张表 */
const CONTRAST_PAIRS: readonly ContrastPair[] = [
  pair('正文 / 主区', '--color-text', ['--color-bg'], TEXT),
  pair('正文 / 侧栏里的选中行', '--color-text', ['--color-bg-side', '--color-fill-2'], TEXT),
  pair('次要字 / 主区', '--color-text-2', ['--color-bg'], TEXT),
  pair('次要字 / 侧栏', '--color-text-2', ['--color-bg-side'], TEXT),
  pair('弱化字 / 主区', '--color-text-3', ['--color-bg'], TEXT),
  pair('弱化字 / 侧栏', '--color-text-3', ['--color-bg-side'], TEXT),
  pair('弱化字 / 侧栏里的选中行', '--color-text-3', ['--color-bg-side', '--color-fill-2'], TEXT),
  pair('弱化字 / 主区里的选中行', '--color-text-3', ['--color-bg', '--color-fill-2'], TEXT),
  pair('弱化字 / 浮层里的高亮项', '--color-text-3', ['--color-surface-raised', '--color-fill-1'], TEXT),
  pair('链接 / 主区', '--color-accent-text', ['--color-bg'], TEXT),
  pair('主按钮的字 / 主按钮', '--color-on-accent', ['--color-accent'], TEXT),
  pair('主按钮的字 / 主按钮悬停', '--color-on-accent', ['--color-accent-hover'], TEXT),
  pair('危险按钮的字 / 危险按钮', '--color-on-accent', ['--color-danger'], TEXT),
  pair('危险按钮的字 / 危险按钮悬停', '--color-on-accent', ['--color-danger-hover'], TEXT),
  pair('危险字 / 主区', '--color-danger-text', ['--color-bg'], TEXT),
  pair('警告字 / 主区', '--color-warning-text', ['--color-bg'], TEXT),
  pair('成功字 / 主区', '--color-success-text', ['--color-bg'], TEXT),
  pair('危险字 / 主区上的危险浅底', '--color-danger-text', ['--color-bg', '--color-danger-subtle'], TEXT),
  pair('危险字 / 侧栏上的危险浅底', '--color-danger-text', ['--color-bg-side', '--color-danger-subtle'], TEXT),
  pair('警告字 / 主区上的警告浅底', '--color-warning-text', ['--color-bg', '--color-warning-subtle'], TEXT),
  pair('警告字 / 侧栏上的警告浅底', '--color-warning-text', ['--color-bg-side', '--color-warning-subtle'], TEXT),
  pair('成功字 / 主区上的成功浅底', '--color-success-text', ['--color-bg', '--color-success-subtle'], TEXT),
  pair('成功字 / 侧栏上的成功浅底', '--color-success-text', ['--color-bg-side', '--color-success-subtle'], TEXT),
  pair('次要字 / 图标栏', '--color-text-2', ['--color-bg-rail'], TEXT),
  ...SYNTAX_PAIRS,
  pair('焦点环 / 主区', '--color-focus', ['--color-bg'], NON_TEXT),
  pair('焦点环 / 侧栏', '--color-focus', ['--color-bg-side'], NON_TEXT),
  pair('输入框外框 / 主区', '--color-border-control', ['--color-bg'], NON_TEXT),
  pair('输入框外框 / 侧栏', '--color-border-control', ['--color-bg-side'], NON_TEXT),
  pair('输入框外框 / 浮层', '--color-border-control', ['--color-surface-raised'], NON_TEXT),
  ...CHART_PAIRS,
  pair('图标 / 图标栏的当前项', '--color-text-2', ['--color-bg-rail', '--color-fill-2'], NON_TEXT),
  pair('金色标记 / 主区', '--color-mark', ['--color-bg'], NON_TEXT),
  pair('金色标记 / 侧栏', '--color-mark', ['--color-bg-side'], NON_TEXT),
  pair('金色标记 / 图标栏', '--color-mark', ['--color-bg-rail'], NON_TEXT),
  pair('金色标记 / 侧栏里的选中行', '--color-mark', ['--color-bg-side', '--color-fill-2'], NON_TEXT),
  pair('金色标记 / 图标栏的当前项', '--color-mark', ['--color-bg-rail', '--color-fill-2'], NON_TEXT),
];

export interface ContrastIssue {
  pair: string;
  /** 算出的对比度，保留两位小数 */
  ratio: number;
  minimum: number;
}

/** 按 WCAG 2 的对比度公式检查主题，列出不达标的组合；没有不达标的回空数组 */
export function themeContrastIssues(theme: Theme): ContrastIssue[] {
  const color = (token: ThemeToken) => parseColor(theme.colors[token]) as Rgba;
  const issues: ContrastIssue[] = [];
  for (const { pair: name, foreground, background, minimum } of CONTRAST_PAIRS) {
    const [bottom, ...layers] = background.map(color);
    const ground = layers.reduce((under, layer) => over(layer, under), bottom);
    const ratio = contrast(over(color(foreground), ground), ground);
    if (ratio < minimum) issues.push({ pair: name, ratio: Math.round(ratio * 100) / 100, minimum });
  }
  return issues;
}

// ----- 颜色写法 -----

/** 0 到 255 的通道与 0 到 1 的不透明度 */
type Rgba = [number, number, number, number];

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION = new RegExp(
  String.raw`^(rgba?|hsla?)\(\s*(${NUMBER})(%|deg)?\s*[,\s]\s*(${NUMBER})(%?)\s*[,\s]\s*(${NUMBER})(%?)\s*(?:[,/]\s*(${NUMBER})(%?)\s*)?\)$`,
  'i',
);

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

/** 只认十六进制、rgb() 与 hsl() 的写法（逗号或空格分隔，可带不透明度）；别的写法回 undefined */
function parseColor(value: string): Rgba | undefined {
  const hex = HEX.exec(value)?.[1];
  if (hex) {
    const digits = hex.length <= 4 ? [...hex].map(d => d + d) : (hex.match(/../g) as string[]);
    const [r, g, b, a = 'ff'] = digits;
    return [r, g, b].map(d => Number.parseInt(d, 16)).concat(Number.parseInt(a, 16) / 255) as Rgba;
  }
  const match = FUNCTION.exec(value);
  if (!match) return undefined;
  const [, fn, first, firstUnit, second, secondUnit, third, thirdUnit, alpha, alphaUnit] = match;
  const a = alpha === undefined ? 1 : clamp(Number(alpha) / (alphaUnit ? 100 : 1), 1);
  if (fn.toLowerCase().startsWith('rgb')) {
    if (firstUnit === 'deg') return undefined;
    const channel = (n: string, percent: string) => clamp(percent ? Number(n) * 2.55 : Number(n), 255);
    return [channel(first, firstUnit ?? ''), channel(second, secondUnit), channel(third, thirdUnit), a];
  }
  if (firstUnit === '%') return undefined;
  return [...hslToRgb(Number(first), clamp(Number(second), 100) / 100, clamp(Number(third), 100) / 100), a];
}

function hslToRgb(hue: number, s: number, l: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 30;
  const k = (n: number) => (n + h) % 12;
  const chroma = s * Math.min(l, 1 - l);
  const f = (n: number) => (l - chroma * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255;
  return [f(0), f(8), f(4)];
}

/** 把半透明的上层叠到不透明的下层 */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

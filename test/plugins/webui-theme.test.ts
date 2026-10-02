import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEMES,
  DEFAULT_THEMES,
  parseTheme,
  THEME_FILE_FORMAT,
  THEME_FILE_VERSION,
  THEME_TOKENS,
  themeContrastIssues,
} from '../../packages/api-webui/src/index.js';

// ════════════════════════════════════════════════════════════
// 主题文件：格式的解析与校验、内置 8 个主题、对比度检查。
// 内置主题与第三方主题同一格式，加载都经 parseTheme；对比度检查是导入时与内置主题共用的同一套组合。
// ════════════════════════════════════════════════════════════

const calmDark = BUILTIN_THEMES['calm-dark'];

/** 一份只写了几个令牌的合法主题文件 */
function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: THEME_FILE_FORMAT,
    version: THEME_FILE_VERSION,
    name: '夜读',
    kind: 'dark',
    colors: { '--color-bg': '#101012', '--color-accent': 'rgb(120 90 230)' },
    ...overrides,
  };
}

function errorsOf(value: unknown): string[] {
  const result = parseTheme(value);
  if (result.ok) throw new Error('期望被拒');
  return result.errors;
}

describe('内置主题', () => {
  it('四种配色各出深浅两个，种类与 id 的后缀一致', () => {
    expect(Object.keys(BUILTIN_THEMES).sort()).toEqual(
      [
        'aalis-dark',
        'aalis-light',
        'brand-dark',
        'brand-light',
        'calm-dark',
        'calm-light',
        'neutral-dark',
        'neutral-light',
      ].sort(),
    );
    for (const [id, theme] of Object.entries(BUILTIN_THEMES)) expect(id.endsWith(`-${theme.kind}`)).toBe(true);
  });

  it.each(Object.keys(BUILTIN_THEMES))('%s 是合格的主题文件，令牌表里的每个名字都写了值', id => {
    const raw = BUILTIN_THEMES[id as keyof typeof BUILTIN_THEMES];
    const result = parseTheme(raw);
    expect(result).toMatchObject({ ok: true });
    expect(Object.keys(raw.colors).sort()).toEqual([...THEME_TOKENS].sort());
  });

  it('跟随系统时的默认：深色用偏中性深色，浅色用偏中性浅色', () => {
    expect(DEFAULT_THEMES).toEqual({ dark: 'calm-dark', light: 'calm-light' });
    expect(BUILTIN_THEMES[DEFAULT_THEMES.dark].kind).toBe('dark');
    expect(BUILTIN_THEMES[DEFAULT_THEMES.light].kind).toBe('light');
  });

  it('默认的偏中性取样稿的色值', () => {
    expect(BUILTIN_THEMES['calm-dark'].colors).toMatchObject({
      '--color-bg': '#1d1d20',
      '--color-bg-side': '#19191c',
      '--color-bg-rail': '#161619',
      '--color-accent': '#6f63c9',
      '--color-accent-text': '#aaa2ec',
      '--color-mark': '#e3b05c',
    });
    expect(BUILTIN_THEMES['calm-light'].colors).toMatchObject({
      '--color-bg': '#fbfbfa',
      '--color-bg-side': '#f4f4f2',
      '--color-bg-rail': '#eeeeec',
      '--color-accent': '#5d52b8',
      '--color-accent-text': '#5247ad',
    });
  });

  it.each(Object.keys(BUILTIN_THEMES))('%s 过对比度检查', id => {
    const result = parseTheme(BUILTIN_THEMES[id as keyof typeof BUILTIN_THEMES]);
    if (!result.ok) throw new Error(result.errors.join('；'));
    expect(themeContrastIssues(result.theme)).toEqual([]);
  });
});

describe('解析与校验', () => {
  it('缺的令牌按同种类的偏中性补齐，写了的照用', () => {
    const result = parseTheme(file());
    if (!result.ok) throw new Error(result.errors.join('；'));
    expect(result.theme.name).toBe('夜读');
    expect(result.theme.kind).toBe('dark');
    expect(result.theme.colors['--color-bg']).toBe('#101012');
    expect(result.theme.colors['--color-accent']).toBe('rgb(120 90 230)');
    expect(result.theme.colors['--color-text']).toBe(calmDark.colors['--color-text']);

    const light = parseTheme(file({ kind: 'light', colors: {} }));
    if (!light.ok) throw new Error(light.errors.join('；'));
    expect(light.theme.colors).toEqual(BUILTIN_THEMES['calm-light'].colors);
  });

  it('认十六进制、rgb() 与 hsl() 的各种写法', () => {
    const colors = {
      '--color-bg': '#abc',
      '--color-bg-side': '#aabbccdd',
      '--color-bg-rail': 'rgba(10, 20, 30, 0.5)',
      '--color-text': 'rgb(10% 20% 30% / 40%)',
      '--color-text-2': 'hsl(240, 50%, 40%)',
      '--color-text-3': 'hsla(240deg 50% 40% / .5)',
    };
    expect(parseTheme(file({ colors }))).toMatchObject({ ok: true });
  });

  it('不是对象、格式名不对、版本不认识的整份拒收，并写明原因', () => {
    expect(errorsOf('{}')).toEqual(['主题文件应是一个 JSON 对象']);
    expect(errorsOf([])).toEqual(['主题文件应是一个 JSON 对象']);
    expect(errorsOf(file({ format: 'css' }))).toEqual([`格式名应为 ${THEME_FILE_FORMAT}`]);
    expect(errorsOf(file({ version: 2 }))).toEqual([`格式版本 2 不认识，只认 ${THEME_FILE_VERSION}`]);
  });

  it('名字、种类不合与多余的字段都拒收', () => {
    expect(errorsOf(file({ name: '  ' }))).toEqual(['名字应是 1 到 40 个字的文本']);
    expect(errorsOf(file({ name: '字'.repeat(41) }))).toEqual(['名字应是 1 到 40 个字的文本']);
    expect(errorsOf(file({ name: 7 }))).toEqual(['名字应是 1 到 40 个字的文本']);
    expect(parseTheme(file({ name: '字'.repeat(40) }))).toMatchObject({ ok: true });
    expect(errorsOf(file({ kind: 'dim' }))).toEqual(['种类应为 dark 或 light']);
    expect(errorsOf(file({ css: 'body{}' }))).toEqual(['多余的字段：css']);
    expect(errorsOf(file({ colors: [] }))).toEqual(['colors 应是一个对象']);
  });

  it('只收令牌表里的名字与颜色写法，样式文本、url()、命名色一律拒收', () => {
    const errors = errorsOf(
      file({
        colors: {
          '--color-bg': 'url(https://example.invalid/x.png)',
          '--color-text': '#fff;}body{display:none',
          '--color-accent': 'red',
          '--color-mark': 'rgb(1, 2)',
          '--color-focus': 'hsl(1 2 3 4 5)',
          '--evil': '#000',
          background: '#000',
        },
      }),
    );
    expect(errors).toEqual([
      '--color-bg 的值不是颜色：url(https://example.invalid/x.png)',
      '--color-text 的值不是颜色：#fff;}body{display:none',
      '--color-accent 的值不是颜色：red',
      '--color-mark 的值不是颜色：rgb(1, 2)',
      '--color-focus 的值不是颜色：hsl(1 2 3 4 5)',
      '--evil 不在令牌表里',
      'background 不在令牌表里',
    ]);
  });
});

describe('对比度检查', () => {
  it('不达标的组合逐条列出：组合名、算出的比值与要求', () => {
    const result = parseTheme(file({ colors: { '--color-text-3': calmDark.colors['--color-bg'] } }));
    if (!result.ok) throw new Error(result.errors.join('；'));
    const issues = themeContrastIssues(result.theme);
    expect(issues.map(issue => issue.pair)).toEqual([
      '弱化字 / 主区',
      '弱化字 / 侧栏',
      '弱化字 / 侧栏里的选中行',
      '弱化字 / 主区里的选中行',
      '弱化字 / 浮层里的高亮项',
    ]);
    expect(issues[0]).toMatchObject({ ratio: 1, minimum: 4.5 });
  });

  /** 主区底是偏中性深色（缺的令牌补齐）时，弱化字写成 color 的「弱化字 / 主区」检查结果 */
  function mutedOnMain(color: string) {
    const result = parseTheme(file({ colors: { '--color-text-3': color } }));
    if (!result.ok) throw new Error(result.errors.join('；'));
    return themeContrastIssues(result.theme).find(issue => issue.pair === '弱化字 / 主区');
  }

  it('文字的门槛是 4.5：差一点的列出，刚过的不列', () => {
    expect(mutedOnMain('#808086')).toEqual({ pair: '弱化字 / 主区', ratio: 4.28, minimum: 4.5 });
    expect(mutedOnMain('#85858b')).toBeUndefined();
  });

  it('rgb() 与 hsl() 写的颜色按换算后的值计算', () => {
    // 两种写法都是偏中性深色的主区底色 #1d1d20
    expect(mutedOnMain('rgb(29 29 32)')).toMatchObject({ ratio: 1 });
    expect(mutedOnMain('hsl(240 4.918% 11.961%)')).toMatchObject({ ratio: 1 });
    // 饱和的颜色：通道换算错位时红会变成别的颜色
    const red = parseTheme(file({ colors: { '--color-bg': '#ff0000', '--color-text-3': 'hsl(0 100% 50%)' } }));
    if (!red.ok) throw new Error(red.errors.join('；'));
    expect(themeContrastIssues(red.theme).find(issue => issue.pair === '弱化字 / 主区')).toMatchObject({ ratio: 1 });
  });

  it('半透明的底色先叠到下层再算', () => {
    // 选中行的 fill-2 若是不透明的正文色，正文落在上面就看不见
    const result = parseTheme(file({ colors: { '--color-fill-2': calmDark.colors['--color-text'] } }));
    if (!result.ok) throw new Error(result.errors.join('；'));
    expect(themeContrastIssues(result.theme).map(issue => issue.pair)).toContain('正文 / 侧栏里的选中行');
  });

  it('图标栏的次要字与图标、金色标记对相邻底色都在检查里', () => {
    const rail = parseTheme(file({ colors: { '--color-bg-rail': calmDark.colors['--color-text-2'] } }));
    const mark = parseTheme(file({ colors: { '--color-mark': calmDark.colors['--color-bg-side'] } }));
    if (!rail.ok || !mark.ok) throw new Error('样例应合格');
    expect(themeContrastIssues(rail.theme).map(issue => issue.pair)).toEqual(
      expect.arrayContaining(['次要字 / 图标栏', '图标 / 图标栏的当前项']),
    );
    expect(themeContrastIssues(mark.theme).map(issue => issue.pair)).toEqual(
      expect.arrayContaining(['金色标记 / 侧栏', '金色标记 / 侧栏里的选中行', '金色标记 / 图标栏的当前项']),
    );
  });
});

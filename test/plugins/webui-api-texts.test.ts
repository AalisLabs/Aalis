import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEME_NAMES,
  BUILTIN_THEMES,
  DEFAULT_SUBSYSTEM_METADATA,
  parseTheme,
  THEME_FILE_FORMAT,
  THEME_FILE_VERSION,
  themeContrastIssues,
} from '../../packages/api-webui/src/index.js';
import { resolveText, type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// api-webui 的库字典：子系统组名、内置主题名（按主题 id 取，主题文件不带名字）与对比度组合名是文字对象，
// 主题文件的校验原因也是，前端按读者语言渲染；这里核英文读者拿到英文、中文读者拿到原文
// ════════════════════════════════════════════════════════════

const english = (text: TextRef) => resolveText(text, ['en']);
const chinese = (text: TextRef) => resolveText(text, ['zh-CN']);

describe('api-webui 的库字典', () => {
  it('子系统组名', () => {
    const labels = new Map(DEFAULT_SUBSYSTEM_METADATA.map(({ id, label }) => [id, label]));
    expect(['system', 'memory', 'persona'].map(id => english(labels.get(id) as TextRef))).toEqual([
      'System',
      'Memory',
      'Persona',
    ]);
    expect(chinese(labels.get('memory') as TextRef)).toBe('记忆');
  });

  it('内置主题名按主题 id 取，主题文件不带名字', () => {
    expect(english(BUILTIN_THEME_NAMES['calm-dark'])).toBe('Mostly neutral dark');
    expect(chinese(BUILTIN_THEME_NAMES['aalis-light'])).toBe('品牌柔和浅色');
    expect(Object.keys(BUILTIN_THEME_NAMES).sort()).toEqual(Object.keys(BUILTIN_THEMES).sort());
    for (const file of Object.values(BUILTIN_THEMES)) expect(file).not.toHaveProperty('name');
  });

  it('对比度组合名', () => {
    const muted = BUILTIN_THEMES['calm-dark'].colors['--color-bg'];
    const result = parseTheme({
      format: THEME_FILE_FORMAT,
      version: THEME_FILE_VERSION,
      name: '夜读',
      kind: 'dark',
      colors: { '--color-text-3': muted },
    });
    if (!result.ok) throw new Error(toSource(result.errors).join('；'));
    const [first] = themeContrastIssues(result.theme);
    expect([english(first.pair), chinese(first.pair)]).toEqual(['Muted text / main area', '弱化字 / 主区']);
  });

  it('主题文件的校验原因', () => {
    const reasons = (value: unknown) => {
      const result = parseTheme(value);
      if (result.ok) throw new Error('期望被拒');
      return result.errors;
    };
    const file = { format: THEME_FILE_FORMAT, version: THEME_FILE_VERSION, name: '夜读', kind: 'dark', colors: {} };
    const errors = [
      ...reasons([]),
      ...reasons({ ...file, format: 'css' }),
      ...reasons({ ...file, version: 2 }),
      ...reasons({
        ...file,
        name: '',
        kind: 'dim',
        css: 'x',
        colors: { '--color-bogus': '#000', '--color-bg': 'red' },
      }),
      ...reasons({ ...file, colors: [] }),
    ];
    expect(errors.map(english)).toEqual([
      'A theme file must be a JSON object',
      `The format name must be ${THEME_FILE_FORMAT}`,
      `Format version 2 isn’t recognized; only ${THEME_FILE_VERSION} is supported`,
      'The name must be 1 to 40 characters of text',
      'The kind must be dark or light',
      'Unexpected field: css',
      '--color-bogus isn’t in the token table',
      'The value of --color-bg isn’t a color: red',
      'colors must be an object',
    ]);
    expect(errors.map(chinese)).toEqual(toSource(errors));
  });
});

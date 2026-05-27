import { describe, expect, it } from 'vitest';
import {
  fixGfmTables,
  normalizeAssistantContent,
  stripDeepSeekSpecialTokens,
} from '../../packages/util-text-normalize/src/index.js';

describe('fixGfmTables', () => {
  it('truncates separator row that has more columns than header', () => {
    const input = ['| A | B |', '|:--|:--|:--|', '| 1 | 2 |'].join('\n');
    const out = fixGfmTables(input);
    expect(out).toBe(['| A | B |', '|:--|:--|', '| 1 | 2 |'].join('\n'));
  });

  it('pads separator row that has fewer columns than header', () => {
    const input = ['| A | B | C |', '|---|---|', '| 1 | 2 | 3 |'].join('\n');
    const out = fixGfmTables(input);
    expect(out).toBe(['| A | B | C |', '|---|---|---|', '| 1 | 2 | 3 |'].join('\n'));
  });

  it('preserves alignment markers when truncating', () => {
    const input = ['| A | B |', '|:--|--:|:--:|', '| 1 | 2 |'].join('\n');
    const out = fixGfmTables(input);
    expect(out).toBe(['| A | B |', '|:--|--:|', '| 1 | 2 |'].join('\n'));
  });

  it('leaves a well-formed table untouched', () => {
    const input = ['| A | B |', '|:--|:--|', '| 1 | 2 |'].join('\n');
    expect(fixGfmTables(input)).toBe(input);
  });

  it('handles tables without leading/trailing pipes', () => {
    const input = ['A | B', ':-- | :-- | :--', '1 | 2'].join('\n');
    const out = fixGfmTables(input);
    expect(out).toBe(['A | B', ':--|:--', '1 | 2'].join('\n'));
  });

  it('skips content inside fenced code blocks', () => {
    const code = ['```md', '| A | B |', '|:--|:--|:--|', '```'].join('\n');
    expect(fixGfmTables(code)).toBe(code);
  });

  it('skips content inside inline code spans', () => {
    const input = 'see `| A | B |\\n|:--|:--|:--|` example';
    expect(fixGfmTables(input)).toBe(input);
  });

  it('fixes multiple tables independently in one document', () => {
    const input = [
      '| A | B |',
      '|:--|:--|:--|',
      '| 1 | 2 |',
      '',
      'paragraph',
      '',
      '| X | Y | Z |',
      '|---|---|',
      '| a | b | c |',
    ].join('\n');
    const out = fixGfmTables(input);
    expect(out).toBe(
      [
        '| A | B |',
        '|:--|:--|',
        '| 1 | 2 |',
        '',
        'paragraph',
        '',
        '| X | Y | Z |',
        '|---|---|---|',
        '| a | b | c |',
      ].join('\n'),
    );
  });

  it('does not treat a horizontal rule as a separator row', () => {
    const input = ['some text', '---', 'more text'].join('\n');
    // prev line has no `|`, so should be left alone
    expect(fixGfmTables(input)).toBe(input);
  });

  it('returns empty string unchanged', () => {
    expect(fixGfmTables('')).toBe('');
  });
});

describe('stripDeepSeekSpecialTokens', () => {
  // 全角竖线 U+FF5C
  const FW = '｜';

  it('strips standard single-pipe DSML block', () => {
    const input = `${''}回答前缀<${FW}DSML${FW}tool_calls><${FW}DSML${FW}invoke name="web_search"><${FW}DSML${FW}parameter name="query" string="true">x</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke></${FW}DSML${FW}tool_calls>`;
    const { sanitized, hadLeak } = stripDeepSeekSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('回答前缀');
  });

  it('strips double-pipe malformed DSML block (observed leak variant)', () => {
    const input = `<${FW}${FW}DSML${FW}${FW}tool_calls><${FW}${FW}DSML${FW}${FW}invoke name="web_search"><${FW}${FW}DSML${FW}${FW}parameter name="query" string="true">狗屁通 梗</${FW}${FW}DSML${FW}${FW}parameter></${FW}${FW}DSML${FW}${FW}invoke></${FW}${FW}DSML${FW}${FW}tool_calls>`;
    const { sanitized, hadLeak } = stripDeepSeekSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('');
  });

  it('strips half-width pipe variant', () => {
    const input = `prefix<|DSML|tool_calls>blah</|DSML|tool_calls>suffix`;
    const { sanitized, hadLeak } = stripDeepSeekSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('prefixsuffix');
  });

  it('strips dangling closing token only (cross-chunk fragment)', () => {
    const input = `已经发出的正文</${FW}${FW}DSML${FW}${FW}tool_calls>`;
    const { sanitized, hadLeak } = stripDeepSeekSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('已经发出的正文');
  });

  it('strips partial unclosed DSML opening (truncated stream)', () => {
    const input = `text<${FW}${FW}DSML${FW}${FW}tool_calls`;
    const { sanitized, hadLeak } = stripDeepSeekSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('text');
  });

  it('returns content unchanged when no DSML present', () => {
    const input = '普通回答，含 < 和 > 符号，以及 | 表格 |';
    const { sanitized, hadLeak } = stripDeepSeekSpecialTokens(input);
    expect(hadLeak).toBe(false);
    expect(sanitized).toBe(input);
  });

  it('handles empty input', () => {
    const { sanitized, hadLeak } = stripDeepSeekSpecialTokens('');
    expect(hadLeak).toBe(false);
    expect(sanitized).toBe('');
  });
});

describe('normalizeAssistantContent', () => {
  const FW = '｜';

  it('combines DSML stripping and GFM table fix', () => {
    const input = [
      '| A | B |',
      '|:--|:--|:--|',
      '| 1 | 2 |',
      `<${FW}${FW}DSML${FW}${FW}tool_calls>leak</${FW}${FW}DSML${FW}${FW}tool_calls>`,
    ].join('\n');
    const out = normalizeAssistantContent(input);
    expect(out).not.toContain('DSML');
    expect(out).toContain('|:--|:--|');
    expect(out).not.toContain('|:--|:--|:--|');
  });

  it('returns empty input as-is', () => {
    expect(normalizeAssistantContent('')).toBe('');
  });
});

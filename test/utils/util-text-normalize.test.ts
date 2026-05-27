import { describe, expect, it } from 'vitest';
import { fixGfmTables } from '../../packages/util-text-normalize/src/index.js';

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

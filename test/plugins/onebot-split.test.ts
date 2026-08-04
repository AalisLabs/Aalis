import { describe, expect, it } from 'vitest';
import { splitMessageByPunctuation } from '../../packages/plugin-adapter-onebot/src/index.js';

// ════════════════════════════════════════════════════════════
// 出站分条不切碎 XML 标记：<at id=..> 提及（昵称含标点）、<video>/<record> 自闭合媒体。
// ════════════════════════════════════════════════════════════

describe('splitMessageByPunctuation 保护 XML 标记', () => {
  it('不切碎 <at id=..> 提及（昵称含逗号）', () => {
    const pieces = splitMessageByPunctuation(
      '这是一段足够长的开头文字。<at id="123">张三，李四</at>这是足够长的结尾文字',
      ['。', '，'],
    );
    expect(pieces.some(p => p.includes('<at id="123">张三，李四</at>'))).toBe(true);
    expect(pieces.some(p => /<at id="123">张三$/.test(p))).toBe(false); // 无半截标记
  });

  it('不切碎 <at self id=..> 与 <at>all</at>', () => {
    const pieces = splitMessageByPunctuation('开头足够长的一段铺垫文字。<at self id="999">机器人</at>收尾文字', ['。']);
    expect(pieces.some(p => p.includes('<at self id="999">机器人</at>'))).toBe(true);
  });

  it('不切碎 <video>/<record> 自闭合标记（url 含分隔符）', () => {
    const pieces = splitMessageByPunctuation('前面是足够长的一段文字，<video url="x，y.mp4"/>后面也足够长的一段', [
      '，',
    ]);
    expect(pieces.some(p => p.includes('<video url="x，y.mp4"/>'))).toBe(true);
  });

  it('普通文本仍正常分条', () => {
    const pieces = splitMessageByPunctuation('第一句足够长的一段话。第二句也足够长的一段话。', ['。']);
    expect(pieces.length).toBeGreaterThan(1);
  });

  it('短片段独立成条，不粘到上一条', () => {
    // 曾有一条「纯文本 < 4 字则合并到上一条」的规则，而合并发生在剥掉尾部切割符**之后**、
    // 且不补任何分隔符，于是产出原文里不存在的字符串：
    //   '……聊天吗。怎么，……' → 切成 '……聊天吗' / '怎么' → 粘成 '……聊天吗怎么'
    // 该规则另有三处非预期行为：首段短则不合并（只往后看）、连续短片段级联粘到同一条、
    // 长度按 UTF-16 码元计（单个 emoji 会被吞）。整条删除。
    const pieces = splitMessageByPunctuation('那你现在是在跟手机壳聊天吗。怎么，问完喜欢的人又要查我户口本了？', [
      '。',
      '，',
    ]);
    expect(pieces).toEqual(['那你现在是在跟手机壳聊天吗', '怎么', '问完喜欢的人又要查我户口本了？']);
    expect(
      pieces.some(p => p.includes('聊天吗怎么')),
      '短片段被无分隔符粘合，产出了原文没有的句子',
    ).toBe(false);
  });
});

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
});

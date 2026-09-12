import { describe, expect, it } from 'vitest';
import { ChatBuffer } from '../../packages/plugin-cli/src/chat-buffer.js';

// CLI 聊天区是扁平行数组，流式回复用绝对下标记住块起点、每个 delta 整块重建。
// 旧实现里裁头不调下标、流式期间的追加落在块后面：超过上限后每个 delta 都把
// 下标错位处的旧行当成流式块重画（阶梯副本），追加的用户输入则被下一个 delta 抹掉。

const history = (n: number, prefix = 'h'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const block = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}`);

describe('ChatBuffer', () => {
  it('历史裁到上限后继续流式不产生副本', () => {
    const buf = new ChatBuffer(300);
    buf.append(history(300));
    for (let n = 1; n <= 8; n++) {
      buf.replaceStreamingBlock(block(n));
      expect(buf.lines.length).toBe(300);
      // 流式块完整地占据末尾一段，且只有一份
      expect(buf.lines.slice(-n)).toEqual(block(n));
      expect(buf.lines.filter(l => l === 's0')).toHaveLength(1);
    }
  });

  it('流式中追加的行落在流式块之前，块保持完整', () => {
    const buf = new ChatBuffer(300);
    buf.append(history(3));
    buf.replaceStreamingBlock(block(2));
    buf.append(['❯ You │ 再说一句']);
    expect(buf.lines).toEqual([...history(3), '❯ You │ 再说一句', ...block(2)]);

    // 下一个 delta 只重建块本身，不碰前面新插入的行
    buf.replaceStreamingBlock(block(3));
    expect(buf.lines).toEqual([...history(3), '❯ You │ 再说一句', ...block(3)]);
  });

  it('裁剪吃进流式块内部时块起点归零，下个 delta 整体重建', () => {
    const buf = new ChatBuffer(4);
    buf.append(history(2));
    buf.replaceStreamingBlock(block(6)); // 6 行块把历史连同自己的前 4 行一起裁掉
    expect(buf.lines).toEqual(['s2', 's3', 's4', 's5']);
    buf.replaceStreamingBlock(block(3));
    expect(buf.lines).toEqual(block(3));
  });

  it('结束流式后追加重新落到末尾', () => {
    const buf = new ChatBuffer(300);
    buf.replaceStreamingBlock(block(2));
    buf.endStreaming();
    expect(buf.streaming).toBe(false);
    buf.append(['after']);
    expect(buf.lines).toEqual([...block(2), 'after']);
  });
});

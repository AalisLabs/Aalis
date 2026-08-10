import { describe, expect, it } from 'vitest';
import { buildRecallNoticeContent } from '../../packages/plugin-adapter-onebot/src/index.js';

// ════════════════════════════════════════════════════════════
// 撤回通知文案（纯函数）。存在理由：撤回通知若只带平台 msg id，LLM 对应不上
// 被撤回的是哪句话（历史呈现不含 messageId）——附上归档原文的时间与摘录后，
// 「谁在何时撤回了哪句话」才成为模型可用的信息。
// ════════════════════════════════════════════════════════════

/** 固定"当前时间"：2026-01-15 20:00 本地时区（消除测试的时间依赖） */
const NOW = new Date(2026, 0, 15, 20, 0, 0).getTime();
/** 同日 14:32 */
const SAME_DAY = new Date(2026, 0, 15, 14, 32, 0).getTime();
/** 前一日 23:50 */
const PREV_DAY = new Date(2026, 0, 14, 23, 50, 0).getTime();

describe('buildRecallNoticeContent', () => {
  it('群聊 + 反查到原文：附时间与摘录，剥掉与通知重复的发送者前缀，压平换行', () => {
    const out = buildRecallNoticeContent({
      isGroup: true,
      userLabel: '张三(10001)',
      messageId: '456',
      original: { content: '[张三(10001)]: 今晚八点\n一起打游戏？', timestamp: SAME_DAY },
      now: NOW,
    });
    expect(out).toBe('[notice/group_recall] 张三(10001) 撤回了一条消息（14:32 发送：「今晚八点 一起打游戏？」）');
  });

  it('管理员代撤：区分操作者与消息主人', () => {
    const out = buildRecallNoticeContent({
      isGroup: true,
      userLabel: '张三(10001)',
      opLabel: '李四(10002)',
      messageId: '456',
      original: { content: '钓鱼链接 example.invalid', timestamp: SAME_DAY },
      now: NOW,
    });
    expect(out).toBe(
      '[notice/group_recall] 李四(10002) 撤回了 张三(10001) 的消息（14:32 发送：「钓鱼链接 example.invalid」）',
    );
  });

  it('查不到原文：退回旧文案（msg id 供人工排查）', () => {
    const out = buildRecallNoticeContent({
      isGroup: true,
      userLabel: '张三(10001)',
      messageId: '456',
      now: NOW,
    });
    expect(out).toBe('[notice/group_recall] 张三(10001) 撤回了一条消息（msg=456）');
  });

  it('原文只剩发送者前缀（无正文）：视同查不到，退回 msg 文案', () => {
    const out = buildRecallNoticeContent({
      isGroup: true,
      userLabel: '张三(10001)',
      messageId: '456',
      original: { content: '[张三(10001)]: ', timestamp: SAME_DAY },
      now: NOW,
    });
    expect(out).toBe('[notice/group_recall] 张三(10001) 撤回了一条消息（msg=456）');
  });

  it('私聊变体', () => {
    const out = buildRecallNoticeContent({
      isGroup: false,
      userLabel: '张三(10001)',
      messageId: '789',
      original: { content: '这句话当我没说', timestamp: SAME_DAY },
      now: NOW,
    });
    expect(out).toBe('[notice/friend_recall] 张三(10001) 撤回了一条私聊消息（14:32 发送：「这句话当我没说」）');
  });

  it('跨日撤回：时间带日期', () => {
    const out = buildRecallNoticeContent({
      isGroup: true,
      userLabel: '张三(10001)',
      original: { content: '昨晚的话', timestamp: PREV_DAY },
      now: NOW,
    });
    expect(out).toContain('（1/14 23:50 发送：「昨晚的话」）');
  });

  it('长原文截断到 60 且不产生孤代理（llm-lone-surrogate 教训）', () => {
    // 第 59-60 个 UTF-16 码元恰好是一个 emoji 代理对的前半：截断必须整体丢弃
    const content = `${'字'.repeat(59)}😀后续还有很多内容${'x'.repeat(50)}`;
    const out = buildRecallNoticeContent({
      isGroup: true,
      userLabel: '张三(10001)',
      original: { content, timestamp: SAME_DAY },
      now: NOW,
    });
    expect(out).toContain('…」）');
    // 孤代理检查：高代理后必须跟低代理，低代理前必须有高代理
    // （String.prototype.isWellFormed 是 ES2024，test 类型门的 lib 停在 ES2023，用正则等价断言）
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(out)).toBe(false);
    expect(out).not.toContain('�');
    // 摘录部分不超过 60 码元 + 省略号
    const excerpt = out.slice(out.indexOf('「') + 1, out.indexOf('」'));
    expect(excerpt.length).toBeLessThanOrEqual(61);
  });
});

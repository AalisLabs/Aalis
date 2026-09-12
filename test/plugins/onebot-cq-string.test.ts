import { describe, expect, it } from 'vitest';
import { normalizeOneBotMessage, segmentsToText } from '../../packages/plugin-adapter-onebot/src/types.js';
import { OneBotV11 } from '../../packages/plugin-adapter-onebot/src/v11.js';
import { checkImmediateMention } from '../../packages/plugin-trigger-policy/src/detector.js';

// ════════════════════════════════════════════════════════════
// OneBot 实现端用「字符串消息格式」（message 为含 [CQ:…] 码的字符串）上报时，
// adapter 入站把它规范化成消息段，之后与数组格式走同一条路径。
//
// 关键不变量：
//   1. <at self> 标记与 selfId 判定只有一处（segmentsToText），@ 判定只认 <at self>；
//   2. 字符串格式与数组格式在 text / attachments / replyToMessageId 上逐字一致；
//   3. CQ 码不会流进下游文本。
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const v11 = new OneBotV11();

function parseString(message: string) {
  return v11.parseMessageEvent(
    {
      time: 0,
      post_type: 'message',
      message_type: 'group',
      self_id: Number(SELF),
      group_id: 20002,
      user_id: 30003,
      message,
    },
    SELF,
  );
}

/** 实现端只给 raw_message 原文（没有 message 字段）的回退路径。 */
function parseRawOnly(rawMessage: string) {
  return v11.parseMessageEvent(
    {
      time: 0,
      post_type: 'message',
      message_type: 'group',
      self_id: Number(SELF),
      group_id: 20002,
      user_id: 30003,
      raw_message: rawMessage,
    },
    SELF,
  );
}

function parseArray(message: Array<{ type: string; data: Record<string, unknown> }>) {
  return v11.parseMessageEvent(
    {
      time: 0,
      post_type: 'message',
      message_type: 'group',
      self_id: Number(SELF),
      group_id: 20002,
      user_id: 30003,
      message,
    },
    SELF,
  );
}

describe('OneBot v11 字符串消息格式入站规范化', () => {
  it('@别人：不产生 <at self>，@ 判定不触发', () => {
    const ev = parseString('[CQ:at,qq=99999] 你好');
    expect(ev).not.toBeNull();
    expect(ev?.text).toBe('<at id="99999">99999</at> 你好');
    expect(ev?.text).not.toContain('CQ:');
    expect(checkImmediateMention(ev?.text ?? '')).toBe(false);
  });

  it('@self：产生 <at self>，@ 判定触发', () => {
    const ev = parseString(`[CQ:at,qq=${SELF}] 在吗`);
    expect(ev?.text).toBe(`<at self id="${SELF}">${SELF}</at> 在吗`);
    expect(checkImmediateMention(ev?.text ?? '')).toBe(true);
  });

  it('@self 与数组格式逐字一致（同一条 segmentsToText 路径）', () => {
    const fromString = parseString(`[CQ:at,qq=${SELF}] 在吗`);
    const fromArray = parseArray([
      { type: 'at', data: { qq: SELF } },
      { type: 'text', data: { text: ' 在吗' } },
    ]);
    expect(fromString?.text).toBe(fromArray?.text);
  });

  it('图片 CQ：附件与数组格式一致', () => {
    const fromString = parseString('看这个[CQ:image,file=a.jpg,url=http://example.invalid/a.jpg]');
    const fromArray = parseArray([
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { file: 'a.jpg', url: 'http://example.invalid/a.jpg' } },
    ]);
    expect(fromString?.attachments).toEqual([{ kind: 'image', url: 'http://example.invalid/a.jpg', name: 'a.jpg' }]);
    expect(fromString?.attachments).toEqual(fromArray?.attachments);
    expect(fromString?.text).toBe(fromArray?.text);
  });

  it('回复 CQ：replyToMessageId 与数组格式一致，回复段不进文本', () => {
    const fromString = parseString('[CQ:reply,id=888][CQ:at,qq=99999] 收到');
    const fromArray = parseArray([
      { type: 'reply', data: { id: '888' } },
      { type: 'at', data: { qq: '99999' } },
      { type: 'text', data: { text: ' 收到' } },
    ]);
    expect(fromString?.replyToMessageId).toBe('888');
    expect(fromString?.replyToMessageId).toBe(fromArray?.replyToMessageId);
    expect(fromString?.text).toBe(fromArray?.text);
  });

  it('语音 CQ + CQ 转义还原（&#91; &#93; &amp;）', () => {
    const ev = parseString('&#91;不是段&#93; a&amp;b[CQ:record,url=http://example.invalid/v.amr]');
    expect(ev?.text).toBe('[不是段] a&b[语音]');
    expect(ev?.attachments).toEqual([{ kind: 'audio', url: 'http://example.invalid/v.amr' }]);
  });

  it('反转义顺序：&amp; 最后还原，字面量 &amp;#91; 不被二次还原成方括号', () => {
    const ev = parseString('写法是 &amp;#91;CQ:at&amp;#93;');
    expect(ev?.text).toBe('写法是 &#91;CQ:at&#93;');
  });
});

// ════════════════════════════════════════════════════════════
// 回退路径：实现端不给 message 段数组、只给 raw_message 原文时，
// 该原文同样是 CQ 字符串，必须走同一条归一化路径。
// ════════════════════════════════════════════════════════════

describe('OneBot v11 raw_message 回退路径', () => {
  it('@self 在回退路径同样产生 <at self>，@ 判定触发', () => {
    const ev = parseRawOnly(`[CQ:at,qq=${SELF}] 在吗`);
    expect(ev?.text).toBe(`<at self id="${SELF}">${SELF}</at> 在吗`);
    expect(ev?.text).not.toContain('CQ:');
    expect(checkImmediateMention(ev?.text ?? '')).toBe(true);
  });

  it('回退路径与 message 字符串路径逐字一致，附件/引用照常提取', () => {
    const raw = '[CQ:reply,id=888]看这个[CQ:image,file=a.jpg,url=http://example.invalid/a.jpg]';
    const fromRaw = parseRawOnly(raw);
    const fromMessage = parseString(raw);
    expect(fromRaw?.text).toBe(fromMessage?.text);
    expect(fromRaw?.replyToMessageId).toBe('888');
    expect(fromRaw?.attachments).toEqual([{ kind: 'image', url: 'http://example.invalid/a.jpg', name: 'a.jpg' }]);
  });
});

// ════════════════════════════════════════════════════════════
// get_msg 回包（引用消息反查）与入站共用同一条归一化路径：
// normalizeOneBotMessage 接受段数组 / CQ 字符串 / raw_message 原文三种载荷。
// ════════════════════════════════════════════════════════════

describe('get_msg 回包的消息载荷归一化', () => {
  it('字符串 message：CQ 码不进引用文本，reply/at 段语义与数组格式一致', () => {
    const fromString = normalizeOneBotMessage('[CQ:reply,id=888][CQ:at,qq=99999] 收到');
    const fromArray = normalizeOneBotMessage([
      { type: 'reply', data: { id: '888' } },
      { type: 'at', data: { qq: '99999' } },
      { type: 'text', data: { text: ' 收到' } },
    ]);
    expect(segmentsToText(fromString, SELF)).toBe('<at id="99999">99999</at> 收到');
    expect(segmentsToText(fromString, SELF)).not.toContain('CQ:');
    expect(segmentsToText(fromString, SELF)).toBe(segmentsToText(fromArray, SELF));
    // reply 段是元数据（不进文本），但 id 要能被引用链反查取到
    expect(fromString.find(seg => seg.type === 'reply')?.data.id).toBe('888');
  });

  it('@self 在引用文本里也标记为 <at self>', () => {
    const segs = normalizeOneBotMessage(`[CQ:at,qq=${SELF}] 在吗`);
    expect(segmentsToText(segs, SELF)).toBe(`<at self id="${SELF}">${SELF}</at> 在吗`);
  });

  it('无 message 时回退 raw_message 原文，同样规范化', () => {
    const segs = normalizeOneBotMessage(undefined, '[CQ:at,qq=99999] 你好');
    expect(segmentsToText(segs, SELF)).toBe('<at id="99999">99999</at> 你好');
  });

  it('空段数组也回退 raw_message；两者皆无时为空数组', () => {
    expect(normalizeOneBotMessage([], '原文')).toEqual([{ type: 'text', data: { text: '原文' } }]);
    expect(normalizeOneBotMessage(undefined, undefined)).toEqual([]);
  });
});

import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  chatModelPicker,
  entryIdOf,
  estimateMsgTokens,
  estimateTextTokens,
  idleTimeout,
  MODEL_REF_TEXT,
  modelRefOf,
} from '../../packages/api-llm/src/index.js';
import { readFieldValue } from '../../packages/schema-config/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';

describe('chatModelPicker', () => {
  it('取能对话的模型；连着取不到时只在第一次调 onMissing，取到之后复位', () => {
    const chat = { id: 'zz-llm/chat', use: { id: 'chat', capabilities: ['chat'] } };
    const embed = { id: 'zz-llm/embed', use: { id: 'embed', capabilities: ['embedding'] } };
    let entries: unknown[] = [embed];
    let missing = 0;
    const pick = chatModelPicker({ list: () => entries as never }, () => missing++);
    expect([pick(), pick(), missing]).toEqual([undefined, undefined, 1]);
    entries = [embed, chat];
    expect(pick()).toBe(chat);
    entries = [];
    expect([pick(), missing]).toEqual([undefined, 2]);
  });
});

describe('estimateTextTokens', () => {
  it('纯 ASCII：约 3.5 字符 / token', () => {
    const t = estimateTextTokens('hello world this is a test');
    // 26 字符 / 3.5 ≈ 8
    expect(t).toBeGreaterThanOrEqual(7);
    expect(t).toBeLessThanOrEqual(9);
  });

  it('纯 CJK：~1.5 token / 字符', () => {
    const t = estimateTextTokens('你好世界这是测试');
    // 8 字符 × 1.5 = 12
    expect(t).toBe(12);
  });

  it('混合：ASCII + CJK 加和', () => {
    const t = estimateTextTokens('hello 你好');
    expect(t).toBeGreaterThan(3);
  });

  it('空字符串返回 0', () => {
    expect(estimateTextTokens('')).toBe(0);
  });
});

describe('estimateMsgTokens', () => {
  it('单条消息基线开销 4 tokens', () => {
    const msg: Message = { role: 'user', content: '' };
    expect(estimateMsgTokens(msg)).toBe(4);
  });
});

describe('idleTimeout', () => {
  it.each([2 ** 31, Number.POSITIVE_INFINITY])('ms 超过定时器上限（%s）时按上限计，不会立刻中止', async ms => {
    const { signal } = idleTimeout(ms);
    await sleep(50);
    expect(signal.aborted).toBe(false);
  });

  it.each([Number.NaN, '5', undefined])('ms 不是数（%s）时抛 RangeError，不当作不限', ms => {
    expect(() => idleTimeout(ms as number)).toThrow(RangeError);
  });

  it('pause 到 resume 之间不计时，resume 之后接着计、不从头计', async () => {
    const timer = idleTimeout(500);
    await sleep(200);
    timer.pause();
    await sleep(700);
    expect(timer.signal.aborted, '暂停期间也计了时').toBe(false);

    timer.resume();
    await sleep(450);
    expect(timer.signal.reason, 'resume 之后从头计了').toMatchObject({ name: 'TimeoutError' });
  });

  it('没暂停时调 resume 不起作用：仍只有一个计时，touch 照常重新计时', async () => {
    const timer = idleTimeout(500);
    timer.resume();
    timer.resume();
    await sleep(300);
    timer.touch();
    await sleep(350);
    expect(timer.signal.aborted, '多挂了一个计时').toBe(false);
  });

  it('已暂停时再调 pause 不起作用：剩下的时间只算第一次暂停时的', async () => {
    const timer = idleTimeout(500);
    await sleep(150);
    timer.pause();
    await sleep(300);
    timer.pause();
    timer.resume();
    await sleep(200);
    expect(timer.signal.aborted, '第二次暂停把暂停期间也扣掉了').toBe(false);
  });
});

describe('模型引用的文字写法', () => {
  it('条目 id 拆成提供者实例 id 与模型 id：跳过 npm scope，模型 id 里的斜杠留在模型里', () => {
    expect(modelRefOf('@aalis/plugin-llm-openai:main/gpt-4o')).toEqual({
      provider: '@aalis/plugin-llm-openai:main',
      model: 'gpt-4o',
    });
    expect(modelRefOf('<提供者>/<厂商>/<模型>')).toEqual({ provider: '<提供者>', model: '<厂商>/<模型>' });
    expect(modelRefOf('@scope/<提供者>/<厂商>/<模型>')).toEqual({
      provider: '@scope/<提供者>',
      model: '<厂商>/<模型>',
    });
  });

  it('拆不出非空的两段时为 undefined', () => {
    for (const text of ['', '<只有提供者>', '<提供者>/', '/<模型>', '@scope/<提供者>', '@scope//<模型>']) {
      expect(modelRefOf(text), text).toBeUndefined();
    }
  });

  it('写成文字就是条目 id，与 /model 列出的写法一致，读回来相同', () => {
    const ref = { provider: '@aalis/plugin-llm-openai:main', model: '<厂商>/<模型>' };
    expect(entryIdOf(ref)).toBe('@aalis/plugin-llm-openai:main/<厂商>/<模型>');
    expect(MODEL_REF_TEXT.fromText(MODEL_REF_TEXT.toText(ref))).toEqual(ref);
  });

  it('字段展开 MODEL_REF_TEXT：服务与模型都要是非空字符串', () => {
    const field = { type: 'llm-ref', label: '模型', ...MODEL_REF_TEXT } as const;
    expect(readFieldValue(field, { provider: '<服务>', model: '<模型>' })).toEqual({
      value: { provider: '<服务>', model: '<模型>' },
    });
    for (const value of ['x', { provider: 1, model: {} }, { provider: '<服务>' }, { provider: '', model: '<模型>' }]) {
      expect(readFieldValue(field, value), JSON.stringify(value)).toHaveProperty('invalid');
    }
  });
});

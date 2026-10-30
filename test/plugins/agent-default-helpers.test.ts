import { describe, expect, it } from 'vitest';
import { estimateMsgTokens } from '../../packages/api-llm/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import {
  describeLLMFailure,
  estimateTokens,
  formatTimeLabel,
  historyStart,
  INPUT_CONVENTIONS,
  isSameMessage,
  readHistory,
} from '../../packages/plugin-agent/src/helpers.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { CONTROL_KINDS, type Message, WellKnownKinds } from '../../packages/schema-message/src/index.js';

describe('formatTimeLabel', () => {
  it('同一天也用绝对日期（相对表述会在零点全体翻转，打穿前缀缓存）', () => {
    const now = new Date('2025-01-15T14:30:00').getTime();
    const ts = new Date('2025-01-15T09:05:00').getTime();
    expect(formatTimeLabel(ts, now)).toBe('1/15 09:05');
  });

  it('跨天同年显示 月/日 HH:mm', () => {
    const now = new Date('2025-01-15T14:30:00').getTime();
    const ts = new Date('2025-01-10T09:05:00').getTime();
    expect(formatTimeLabel(ts, now)).toBe('1/10 09:05');
  });

  it('跨年显示 年/月/日 HH:mm', () => {
    const now = new Date('2025-01-15T14:30:00').getTime();
    const ts = new Date('2024-12-30T09:05:00').getTime();
    expect(formatTimeLabel(ts, now)).toBe('2024/12/30 09:05');
  });
});

describe('estimateTokens', () => {
  it('多条消息求和', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(estimateTokens(msgs)).toBe(estimateMsgTokens(msgs[0]) + estimateMsgTokens(msgs[1]));
  });
});

describe('historyStart', () => {
  it('条数线为 0、或活跃条数不超过它时为 0', () => {
    expect([historyStart(0, 20), historyStart(20, 20), historyStart(600, 0)]).toEqual([0, 0, 0]);
  });

  it('超过条数线时按半条线成段前移，两次前移之间不变；一次跨好几段时落在半条线的整数倍上', () => {
    // 条数线 20、半条线 10：(20, 30] 起点 10，(30, 40] 起点 20
    expect([21, 25, 30, 31, 40, 57].map(n => historyStart(n, 20))).toEqual([10, 10, 10, 20, 20, 40]);
    // 奇数条数线的半条线向上取整
    expect([6, 8, 9].map(n => historyStart(n, 5))).toEqual([3, 3, 6]);
  });
});

describe('readHistory', () => {
  const user = (i: number): Message => ({ role: 'user', content: `m${i}`, timestamp: 1000 + i });
  const users = (n: number) => Array.from({ length: n }, (_, i) => user(i));
  /** n 条用户消息，第 9、10 条换成一组工具调用：带调用的助手与它的结果 */
  const withToolGroup = (n: number) => {
    const list = users(n);
    const call = { id: 'call-9', type: 'function' as const, function: { name: 'zz_probe', arguments: '{}' } };
    list[9] = { role: 'assistant', content: null, toolCalls: [call], timestamp: 1009 };
    list[10] = { role: 'tool', content: 'ok', toolCallId: call.id, timestamp: 1010 };
    return list;
  };
  /**
   * 照契约按条数读的后端：只数对话消息，读出第 limit+1 新的那条对话消息之后的全部。记下 getHistory 收到的条数；counts 为假时
   * 不带 countHistory
   */
  function store(messages: Message[], counts: boolean) {
    const limits: number[] = [];
    const said = messages.flatMap((m, i) => (CONTROL_KINDS.includes(m.kind ?? '') ? [] : [i]));
    const memory: Pick<MemoryService, 'getHistory' | 'countHistory'> = {
      getHistory: async (_sessionId, limit = 50) => {
        limits.push(limit);
        return messages.slice((said[said.length - limit - 1] ?? -1) + 1);
      },
      ...(counts ? { countHistory: async () => said.length } : {}),
    };
    return { memory, limits };
  }
  const contents = (messages: Message[]) => messages.map(m => m.content);

  it('后端有 countHistory 时先数再只读起点之后，没有时读全部再切，两条路得到同一段', async () => {
    const counted = store(users(25), true);
    const plain = store(users(25), false);
    const expected = { count: 25, messages: users(25).slice(10) };

    expect(await readHistory(counted.memory, 's', 20)).toEqual(expected);
    expect(await readHistory(plain.memory, 's', 20)).toEqual(expected);
    expect([counted.limits, plain.limits]).toEqual([[15], [Infinity]]);
  });

  it('只数对话消息：没有 countHistory 时读全部再从起点那条对话消息之后切，与按条数读的同一段', async () => {
    // 25 条用户消息，m0、m3、m6……之后各跟一条事件标记
    const list = users(25).flatMap((m, i): Message[] =>
      i % 3 === 0
        ? [m, { role: 'system', kind: WellKnownKinds.EventMarker, content: '', timestamp: m.timestamp }]
        : [m],
    );
    // 对话消息 25 条，条数线 20、半条线 10：丢掉最早的 10 条对话消息（到 m9 为止），m9 之前的标记随之丢掉，m9 之后那条留下
    const expected = { count: 25, messages: list.slice(list.findIndex(m => m.content === 'm9') + 1) };
    expect(expected.messages[0].kind).toBe(WellKnownKinds.EventMarker);

    expect(await readHistory(store(list, true).memory, 's', 20)).toEqual(expected);
    expect(await readHistory(store(list, false).memory, 's', 20)).toEqual(expected);
  });

  it('起点落在工具调用组中间时去掉开头连续的工具结果（组首在起点之前，已一起丢掉）', async () => {
    for (const counts of [true, false]) {
      const { memory } = store(withToolGroup(25), counts);
      const { messages, count } = await readHistory(memory, 's', 20);
      expect(count).toBe(25);
      expect(contents(messages)).toEqual(Array.from({ length: 14 }, (_, i) => `m${i + 11}`));
    }
  });

  it('按时间戳读历史的存储把别的消息排进了工具调用组：起点落在组里时，这一组留下的结果随组首一起丢，夹进来的照留', async () => {
    // 存储的次序就是按时间戳读回的次序：第 9 条是调用，第 10 条是组写入期间到的、排在调用与结果之间，第 11 条是结果
    const list = users(25);
    const call = { id: 'call-9', type: 'function' as const, function: { name: 'zz_probe', arguments: '{}' } };
    list[9] = { role: 'assistant', content: null, toolCalls: [call], timestamp: 1009 };
    list[11] = { role: 'tool', content: 'ok', toolCallId: call.id, timestamp: 1010 };
    for (const counts of [true, false]) {
      const { memory } = store(list, counts);
      const { messages } = await readHistory(memory, 's', 20);
      expect(contents(messages)).toEqual([10, ...Array.from({ length: 13 }, (_, i) => i + 12)].map(i => `m${i}`));
    }
  });

  it('没有成段丢弃时开头原样交给清洗；条数线为 0 时读全部，不数条数', async () => {
    const orphan: Message[] = [{ role: 'tool', content: 'ok', toolCallId: 'call-0', timestamp: 999 }, user(0), user(1)];
    const { memory, limits } = store(orphan, true);

    expect(await readHistory(memory, 's', 20)).toEqual({ count: 3, messages: orphan });
    expect(await readHistory(memory, 's', 0)).toEqual({ count: 3, messages: orphan });
    expect(await readHistory(memory, 's', undefined)).toEqual({ count: 3, messages: orphan });
    expect(limits).toEqual([20, Infinity, Infinity]);
  });

  it('没超线时照读最近条数线那么多条：数完到读之间进来的新消息不会把最早那条挤出去', async () => {
    const messages = users(3);
    const memory: Pick<MemoryService, 'getHistory' | 'countHistory'> = {
      getHistory: async (_sessionId, limit = 50) => messages.slice(-limit),
      countHistory: async () => {
        const count = messages.length;
        messages.push(user(3));
        return count;
      },
    };

    expect(await readHistory(memory, 's', 20)).toEqual({ count: 3, messages: users(4) });
  });
});

describe('isSameMessage', () => {
  it('role + timestamp + name + content 全等则为同一消息', () => {
    const a: Message = { role: 'user', content: 'hi', timestamp: 1000, name: 'alice' };
    const b: Message = { role: 'user', content: 'hi', timestamp: 1000, name: 'alice' };
    expect(isSameMessage(a, b)).toBe(true);
  });

  it('content 不同则不同', () => {
    const a: Message = { role: 'user', content: 'hi', timestamp: 1000 };
    const b: Message = { role: 'user', content: 'hello', timestamp: 1000 };
    expect(isSameMessage(a, b)).toBe(false);
  });

  it('timestamp 不同则不同', () => {
    const a: Message = { role: 'user', content: 'hi', timestamp: 1000 };
    const b: Message = { role: 'user', content: 'hi', timestamp: 1001 };
    expect(isSameMessage(a, b)).toBe(false);
  });
});

describe('INPUT_CONVENTIONS', () => {
  it('包含输入约定标题', () => {
    expect(INPUT_CONVENTIONS).toContain('【输入约定】');
    expect(INPUT_CONVENTIONS).toContain('<forward');
  });
});

describe('describeLLMFailure — 让 LLM 解析失败可诊断', () => {
  /** 说明是文字对象，这里核原文 */
  const explain = (...args: Parameters<typeof describeLLMFailure>) => toSource(describeLLMFailure(...args));

  // 这条曾经是一次真实事故：包改名（plugin-deepseek → plugin-llm-deepseek）后，配置里的
  // llm-ref 全部指向不存在的 entry，整机 LLM 静默全哑，而日志只说「LLM 服务不可用，请检查配置」
  // ——服务其实注册得好好的，坏的只是那条 ref。
  it('一个 entry 都没有 → 提示去装/启用提供者插件', () => {
    const s = explain([]);
    expect(s).toContain('未找到任何具备 chat 能力的 LLM');
    expect(s).not.toContain('配置指向');
  });

  // 实测过的空转路径：照文档 `--yes` 起步 → deepseek 缺 key 激活失败（ERROR 只在终端日志里）
  // → 聊天里却说「请确认已安装并启用」，而装和启用这两条都对得上，用户会顺着错误方向排查一轮。
  it('没有可用 entry 但有 LLM 插件处于 error 态 → 点名实例并指向 /doctor，不再让人去查装没装', () => {
    const s = explain([], undefined, ['@aalis/plugin-llm-deepseek', '@aalis/plugin-llm-openai:main']);
    expect(s).toMatch(
      /激活失败：@aalis\/plugin-llm-deepseek、@aalis\/plugin-llm-openai:main。可用 \/doctor 查看原因（需要相应权限）/,
    );
    expect(s, '不能再指向「装没装/启没启用」这条错误路径').not.toContain('请确认已安装并启用');
  });

  it('没有可用 entry 且没有 error 态插件 → 回落到原来的通用提示', () => {
    expect(explain([], undefined, [])).toContain('请确认已安装并启用');
  });

  it('有 entry 但配置 ref 对不上 → 同时报出要找的与现有的', () => {
    const s = explain(['@aalis/plugin-llm-deepseek/deepseek-v4-flash'], {
      provider: '@aalis/plugin-deepseek',
      model: 'deepseek-v4-flash',
    });
    // 钉**角色位**而不是「两个串都出现过」：把 wanted 与 available 互换后语义完全颠倒
    // （会把人指向反方向排查），而两条 toContain 对这种互换完全免疫。
    expect(s, '要找的与现有的必须各就各位').toMatch(
      /不存在：@aalis\/plugin-deepseek\/deepseek-v4-flash。当前可用：[^。]*@aalis\/plugin-llm-deepseek\/deepseek-v4-flash/,
    );
  });

  it('未配置 ref 时不谎称「配置指向」，也不谎称「都不可用」', () => {
    const s = explain(['@aalis/plugin-llm-ollama/gemma4:26b-mlx'], undefined);
    expect(s).not.toContain('配置指向');
    // 这条分支在生产其实不可达（ref 不全时 resolveLLMModel 取 all[0]，有 entry 必命中），
    // 所以它不该说「均不可用」——那与「有 1 个可用 entry」自相矛盾。
    expect(s).toContain('1 个可用 entry');
  });

  it('可用列表过长时截断——这条文案会发进聊天，ollama 能有几十个 entry', () => {
    const many = Array.from({ length: 40 }, (_, i) => `@aalis/plugin-llm-ollama/model-${i}`);
    const s = explain(many, { provider: 'p', model: 'm' });
    expect(s.length, `实测未截断时 40 个模型拼出 1874 字符，当前 ${s.length}`).toBeLessThan(300);
    expect(s).toContain('model-4 等 40 个（用 /model 查看全部）');
  });

  it('ref 只有一半（缺 model）时按未配置处理', () => {
    const s = explain(['x/y'], { provider: '@aalis/plugin-llm-deepseek' });
    expect(s).not.toContain('配置指向');
  });
});

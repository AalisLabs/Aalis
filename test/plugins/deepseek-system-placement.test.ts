import { App } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import * as deepseekModule from '../../packages/plugin-llm-deepseek/src/index.js';
import { normalizeSystemPlacement } from '../../packages/plugin-llm-deepseek/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { WellKnownKinds } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// DeepSeek 角色归一化：受控实验证实 DeepSeek 把 messages 里所有 system
// 消息提升合并到渲染流最前部——历史后的每轮易变块与历史中段的通知因此
// 落在 append-only 历史之前，每轮打穿前缀缓存。归一化规则：首个非 system
// 之后的 system 一律转 user（无方括号标记者补 [系统提示] 换行前缀）；
// 跨会话委派指令豁免（必须保持 system，否则复发「把委派当用户指挥」）。
// ════════════════════════════════════════════════════════════

/** 典型 agent 请求形状：头部稳定区 + 历史（混通知）+ 尾部每轮材料 + 当前消息 */
function agentShape(): Message[] {
  return [
    { role: 'system', content: '人设正文与输出格式约定' },
    { role: 'system', content: '═══ 可用技能清单 ═══' },
    { role: 'system', content: '【会话摘要】此前讨论了……' },
    { role: 'user', content: '(今天 10:00) [张三(10001)]: 早', name: '10001' },
    { role: 'assistant', content: '早呀' },
    { role: 'system', content: '[系统通知] 李四(10002) 撤回了一条消息（10:01 发送：「打错了」）' },
    { role: 'user', content: '(今天 10:02) [张三(10001)]: 昨天说到哪了', name: '10001' },
    { role: 'system', content: '📜 以下是从其他会话检索到的消息片段……' },
    { role: 'system', content: '# 当前状态\n时间：今天 10:03；上一轮：平静' },
    { role: 'user', content: '(今天 10:03) [张三(10001)]: 继续吧', name: '10001' },
  ];
}

describe('normalizeSystemPlacement', () => {
  it('头部连续 system 区原样保留，其后 system 全部转 user，数组位置不变', () => {
    const out = normalizeSystemPlacement(agentShape());
    expect(out.map(m => m.role)).toEqual([
      'system',
      'system',
      'system', // 头部三块不动
      'user',
      'assistant',
      'user', // 通知转 user
      'user',
      'user',
      'user', // 尾部两块转 user
      'user',
    ]);
    expect(out).toHaveLength(10);
  });

  it('已带方括号标记的不重复加前缀；无标记的补 [系统提示] 换行前缀（markdown 标题保持行首）', () => {
    const out = normalizeSystemPlacement(agentShape());
    expect(out[5].content).toBe('[系统通知] 李四(10002) 撤回了一条消息（10:01 发送：「打错了」）');
    expect(out[7].content).toBe('[系统提示]\n📜 以下是从其他会话检索到的消息片段……');
    expect(out[8].content).toBe('[系统提示]\n# 当前状态\n时间：今天 10:03；上一轮：平静');
  });

  it('跨会话委派指令豁免：保持 system 角色（历史 BUG——转 user 会被当成用户在指挥）', () => {
    const out = normalizeSystemPlacement([
      { role: 'system', content: '人设' },
      { role: 'user', content: '(今天 09:00) [张三(10001)]: 旧消息', name: '10001' },
      {
        role: 'system',
        content: '[跨会话委派 — 非用户消息]\n任务: 去目标群发布提醒',
        metadata: { injector: WellKnownKinds.CrossSessionDelegation },
      },
    ]);
    expect(out.map(m => m.role)).toEqual(['system', 'user', 'system']);
  });

  it('空内容 system 块保持原样，不产出空壳 user 消息', () => {
    const out = normalizeSystemPlacement([
      { role: 'system', content: '头' },
      { role: 'user', content: '问' },
      { role: 'system', content: '' },
      { role: 'system', content: null },
    ]);
    expect(out[2]).toMatchObject({ role: 'system', content: '' });
    expect(out[3]).toMatchObject({ role: 'system', content: null });
  });

  it('user 开头（无头部 system）时，后续 system 也转', () => {
    const out = normalizeSystemPlacement([
      { role: 'user', content: '问题' },
      { role: 'system', content: '补充材料' },
    ]);
    expect(out.map(m => m.role)).toEqual(['user', 'user']);
    expect(out[1].content).toBe('[系统提示]\n补充材料');
  });

  it('全 system 数组（如纯指令请求）整体视为头部，不转', () => {
    const msgs: Message[] = [
      { role: 'system', content: '指令' },
      { role: 'system', content: '委派任务' },
    ];
    expect(normalizeSystemPlacement(msgs).map(m => m.role)).toEqual(['system', 'system']);
  });

  it('幂等：归一化两次与一次结果相同', () => {
    const once = normalizeSystemPlacement(agentShape());
    expect(normalizeSystemPlacement(once)).toEqual(once);
  });

  it('不改动输入；转换保留 metadata/kind/name；非 system 消息同引用透传', () => {
    const input: Message[] = [
      { role: 'system', content: '头' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        reasoningContent: '想',
      },
      { role: 'tool', content: '结果', toolCallId: 'c1' },
      { role: 'system', content: '尾块', kind: 'x', name: 'n', metadata: { injector: 'some-injector' } },
    ];
    const out = normalizeSystemPlacement(input);
    expect(input[3].role).toBe('system'); // 输入未被就地改写
    expect(out[1]).toBe(input[1]); // 非 system 消息同引用透传
    expect(out[1].toolCalls?.[0]?.id).toBe('c1');
    expect(out[2].toolCallId).toBe('c1');
    expect(out[3]).toMatchObject({
      role: 'user',
      content: '[系统提示]\n尾块',
      kind: 'x',
      name: 'n',
      metadata: { injector: 'some-injector' },
    });
  });
});

// ── 接线断言：真实 chat() 出口确实套用了归一化（防调用点被静默删除） ──

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('chat 出口接线', () => {
  it('发出的请求体里尾部 system 已转 user，头部 system 保留', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(deepseekModule as never, { apiKey: 'test-key' });
    await app.plugins.idle();
    const llm = app.ctx.getService<LLMModel>('llm');
    if (!llm) throw new Error('llm entry 未注册');
    await llm.chat({
      messages: [
        { role: 'system', content: '人设' },
        { role: 'user', content: '(今天 10:00) [张三(10001)]: 早' },
        { role: 'system', content: '当前状态：平静' },
      ],
    });
    await app.stop();

    expect(capturedBody?.messages.map(m => m.role)).toEqual(['system', 'user', 'user']);
    expect(capturedBody?.messages[2]?.content).toBe('[系统提示]\n当前状态：平静');
  });
});

/**
 * @aalis/plugin-prompt-budget —— 暴露 Prompt 预算自检工具
 *
 * 设计动机：plugin-agent-default 已 emit `token:usage` 事件（含 12 桶 breakdown），
 * WebUI 通过 plugin-webui-server 订阅并渲染面板。但 AI 自己跑在工具循环里时，
 * 没有看 WebUI 的机会——需要一个**主动 query** 路径，让模型怀疑"是不是 prompt 太大了"
 * 时能立即查到当前 session 的最新预算消耗。
 *
 * 实现：监听 `token:usage` 事件维护 sessionId → 最新 usage 缓存，注册
 * `prompt_budget_info` 工具供 AI 查询。零业务逻辑，纯只读 introspection。
 */

import type { Context } from '@aalis/core';
import type { TokenUsageEvent } from '@aalis/plugin-agent-api';
import { useToolService } from '@aalis/plugin-tools-api';
import { createBoundedMap } from '@aalis/util-bounded-map';
import '@aalis/plugin-tools-api';

export const name = '@aalis/plugin-prompt-budget';
export const displayName = 'Prompt 预算自检';
export const subsystem = 'agent';

/** 事件契约形状来自 @aalis/plugin-agent-api 的 TokenUsageEvent，本插件只追加入库时刻 */
interface TokenUsage extends TokenUsageEvent {
  /** 本插件追加：记录入库时刻，方便 AI 判断数据新鲜度 */
  observedAt: number;
}

export function apply(ctx: Context): void {
  const tools = useToolService(ctx);
  /** sessionId → 最新一次的 token:usage 快照（派生只读，逐出后 AI 重查即重算）；有界防长跑泄漏 */
  const cache = createBoundedMap<string, TokenUsage>({ max: 500, ttlMs: 6 * 60 * 60 * 1000 });

  ctx.on('token:usage', u => {
    if (!u || typeof u.sessionId !== 'string') return;
    cache.set(u.sessionId, { ...u, observedAt: Date.now() });
  });

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'prompt_budget_info',
        description:
          '查询当前 session 最近一次 LLM 调用的 prompt token 预算消耗。' +
          '当你怀疑"system prompt 过大""上下文快满了"或想验证压缩 / 工具裁剪是否生效时使用。' +
          '返回 12 桶 breakdown（system / persona / memorySummary / memoryVector / skills / ' +
          'platform / subtask / systemOther / history / toolResults / toolDefs / reservedForReply）' +
          '及 used / contextWindow / usageRatio。' +
          '注意：数据由上一次 LLM 调用 emit，刚启动或未调用时返回 noData。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: '可选。默认使用当前调用 session（callCtx.sessionId）；传入可查询其他会话。',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const sessionId = (args.sessionId as string) || callCtx.sessionId;
      const u = cache.get(sessionId);
      if (!u) {
        return JSON.stringify({
          noData: true,
          sessionId,
          advice:
            '本 session 尚未产生 token:usage 事件（可能是首轮调用前或本 session 从未调过 LLM）。' +
            '在 LLM 至少调用一次后再查询本工具即可。',
        });
      }
      const ageMs = Date.now() - u.observedAt;
      const tag =
        u.usageRatio >= 0.85 ? 'CRITICAL' : u.usageRatio >= 0.7 ? 'WARN' : u.usageRatio >= 0.5 ? 'INFO' : 'OK';
      // top3 提示哪几个桶最大
      const buckets = Object.entries(u.breakdown).sort((a, b) => b[1] - a[1]);
      const top3 = buckets.slice(0, 3).map(([k, v]) => ({ name: k, tokens: v }));
      const advice =
        u.usageRatio >= 0.85
          ? '上下文几乎用尽。建议：调用 memory.compress / 清理 toolResults / 缩减 system prompt。'
          : u.usageRatio >= 0.7
            ? '上下文压力较高。可考虑主动压缩历史或减少后续工具调用的输出体量。'
            : '预算健康，无需干预。';
      return JSON.stringify({
        sessionId,
        ageMs,
        observedAt: new Date(u.observedAt).toISOString(),
        tag,
        used: u.used,
        contextWindow: u.contextWindow,
        usageRatio: Number(u.usageRatio.toFixed(4)),
        maxTokens: u.maxTokens,
        tokenBudget: u.tokenBudget,
        breakdown: u.breakdown,
        top3,
        advice,
      });
    },
  });

  ctx.onDispose(() => cache.clear());
  ctx.logger.info('prompt_budget_info 工具已注册');
}

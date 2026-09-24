import { describe, expect, it } from 'vitest';
import type { TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, services } from '../../packages/core/src/index.js';
import promptBudget from '../../packages/plugin-prompt-budget/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// prompt_budget_info 的 top3 与 advice：
//   - breakdown 里的 injectors 是 Record 而非 token 数，混进排序会让比较器返回 NaN，
//     排序结果按规范属未定义行为。本用例用生产量级的 breakdown 钉住"top3 恒等于真实
//     数值桶前三、tokens 恒为有限数"这条不变量——去掉数值过滤后，V8 实测会把最大桶
//     history(20000) 挤出前三，排序结果确实是错的。
//   - advice 不得再指模型去调全仓不存在的 memory.compress，也不得写死压缩阈值数字。
// ════════════════════════════════════════════════════════════

const usage: TokenUsageEvent = {
  sessionId: 'zz-budget',
  platform: 'test',
  contextWindow: 32_000,
  maxTokens: 4096,
  tokenBudget: 27_904,
  used: 27_000,
  usageRatio: 0.9,
  breakdown: {
    system: 5000,
    persona: 2500,
    memorySummary: 1200,
    memoryVector: 800,
    skills: 400,
    platform: 100,
    subtask: 0,
    systemOther: 0,
    injectors: {},
    history: 20_000,
    toolResults: 3000,
    toolDefs: 1500,
    reservedForReply: 4096,
  },
};

describe('prompt_budget_info 的 top3 与 advice', () => {
  it('top3 只含数值桶且等于真实前三；advice 不再教模型调 memory.compress', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    await app.plugin(toolsPlugin, {});
    await app.plugin(promptBudget, {});
    await app.plugins.idle();
    // 激活闸会把依赖不全的插件停在 pending 而不报错，那时工具不存在、事件也没人听——当场点名，
    // 免得后面的报错落在 registry.execute 上、指不出真正的原因
    for (const name of [toolsPlugin.name, promptBudget.name]) {
      const state = app.plugins.getPlugin(name)?.state;
      if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
    }
    const host = app.bind({ services, events });
    const registry = host.services.get(tools)!;

    const query = async () => {
      const result = await registry.execute(
        'prompt_budget_info',
        { sessionId: 'zz-budget' },
        { sessionId: 'zz-budget', platform: 'test' },
      );
      return JSON.parse(result.content) as {
        tag: string;
        top3: Array<{ name: string; tokens: number }>;
        advice: string;
      };
    };

    await host.events.emit('token:usage', usage);
    const payload = await query();

    // 0.75 落在 WARN 支路：这条支路与 CRITICAL 共用同一句 compressionNote，别漏改
    await host.events.emit('token:usage', { ...usage, usageRatio: 0.75 });
    const warn = await query();
    await app.stop();

    expect(payload.top3.map(b => b.name)).toEqual(['history', 'system', 'reservedForReply']);
    expect(payload.top3.every(b => Number.isFinite(b.tokens))).toBe(true);
    expect(payload.advice).not.toContain('memory.compress');
    expect(payload.advice, 'advice 不得写死压缩阈值').not.toContain('0.7');

    expect(warn.tag).toBe('WARN');
    expect(warn.advice, 'WARN 支路也要讲清压缩不归模型管').toContain('历史压缩不由模型发起');
    expect(warn.advice).not.toContain('memory.compress');
    expect(warn.advice, 'advice 不得写死压缩阈值').not.toContain('0.7');
  });
});

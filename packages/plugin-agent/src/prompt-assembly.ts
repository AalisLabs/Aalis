// ============================================================
// prompt-assembly.ts — agent:prompt 贡献点的组装器（收集方策略）
//
// 内核贡献原语只管注册与确定性枚举；如何执行 build（并行、错误隔离、
// 幂等重跑、锚位排布、物化形态）全在这里——这是贡献点 owner 的策略层。
//
// 每次 LLM 调用前运行（含工具循环各轮）。幂等靠全局键：messages 中已带
// `metadata.injector === 全局键` 的贡献不再 build（向量检索等昂贵构建
// 物化一次后不再重跑）；返回 null 的贡献因键未物化，下一轮会再试——与旧
// middleware 的逐轮重查行为一致。回合中途新注册的贡献（如 load_skill
// 激活新技能）在下一轮被增量物化。
// ============================================================

import type { Context } from '@aalis/core';
import type { PromptAnchor, PromptContributionView } from '@aalis/plugin-agent-api';
import type { Message } from '@aalis/plugin-message-api';

/** 锚位排布次序（同一轮组装内生效；语义见 agent-api 的 PromptAnchor 文档） */
const ANCHOR_ORDER: readonly PromptAnchor[] = ['identity', 'knowledge', 'context', 'turn-hint'];

/** 各锚位在 messages 中的插入位置；返回 -1 = 本轮弃置该槽 */
function anchorInsertAt(anchor: PromptAnchor, messages: readonly Message[]): number {
  switch (anchor) {
    case 'identity': {
      const idx = messages.findIndex(m => m.role === 'system');
      return idx >= 0 ? idx + 1 : 0;
    }
    case 'knowledge':
    case 'context': {
      // 头部 system 区末尾。顺序靠 ANCHOR_ORDER 串行插入保证：knowledge 先落位，
      // context 再取"第一条非 system"时自然排在其后。
      const idx = messages.findIndex(m => m.role !== 'system');
      return idx === -1 ? messages.length : idx;
    }
    case 'turn-hint': {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return i;
      }
      return -1; // 无 user 消息，弃置
    }
  }
}

/**
 * 收集 agent:prompt 贡献并物化进 messages（原地 splice）。
 *
 * - 并行 build，单个贡献抛错仅自身缺席（warn 日志），不连坐、不中断；
 * - 返回 null / 空数组 = 本轮不交料；返回多块保序、共用同一全局键；
 * - 排布：锚位按 ANCHOR_ORDER，槽内按全局键码元序（collect 已排好）；
 * - 物化形态与旧手搓注入一致：`{role:'system', content, metadata:{injector: 全局键}}`，
 *   trim / token 统计 / WebUI 零改动。
 */
export async function assemblePromptContributions(
  ctx: Context,
  data: {
    messages: Message[];
    sessionId?: string;
    userId?: string;
    platform?: string;
    triggerType?: PromptContributionView['triggerType'];
    dryRun?: boolean;
  },
): Promise<void> {
  const entries = ctx.collect('agent:prompt');
  if (entries.length === 0) return;

  const { messages } = data;
  const pending = entries.filter(e => !messages.some(m => m.role === 'system' && m.metadata?.injector === e.key));
  if (pending.length === 0) return;

  const view: PromptContributionView = {
    sessionId: data.sessionId,
    userId: data.userId,
    platform: data.platform,
    triggerType: data.triggerType,
    dryRun: data.dryRun === true,
    // 浅拷贝快照：build 是并行执行的，把活数组递进去，某个 build 若强转
    // readonly 去 splice 会与其他 build 的读跨 await 竞态（旧串行中间件无此
    // 窗口）。快照杀掉数组层竞态；消息对象本身不深拷贝——与旧时代同信任级。
    messages: [...messages],
  };

  type Built = { key: string; anchor: PromptAnchor; blocks: string[] };
  const built = (
    await Promise.all(
      pending.map(async ({ key, spec }): Promise<Built | null> => {
        try {
          const out = await spec.build(view);
          if (out == null) return null;
          const blocks = (typeof out === 'string' ? [out] : out).filter(b => b.length > 0);
          return blocks.length > 0 ? { key, anchor: spec.anchor, blocks } : null;
        } catch (err) {
          ctx.logger.warn(`agent:prompt 贡献 "${key}" 构建失败（本轮缺席）:`, err);
          return null;
        }
      }),
    )
  ).filter(r => r !== null);

  for (const anchor of ANCHOR_ORDER) {
    // pending 继承 collect 的键序 → 槽内自然按全局键码元序
    const group = built.filter(r => r.anchor === anchor);
    if (group.length === 0) continue;
    const insertAt = anchorInsertAt(anchor, messages);
    if (insertAt < 0) {
      ctx.logger.debug(`agent:prompt 锚位 "${anchor}" 本轮无落点，弃置 ${group.length} 份贡献`);
      continue;
    }
    messages.splice(
      insertAt,
      0,
      ...group.flatMap(({ key, blocks }) =>
        blocks.map((content): Message => ({ role: 'system', content, metadata: { injector: key } })),
      ),
    );
  }

  // 锚位拼错（PromptAnchor 是编译期联合，JS 侧第三方可传任意串）会让产物无声
  // 蒸发：既不物化、键也不落，下一轮还会重跑 build。点名报出，别让它静默。
  const stray = built.filter(r => !ANCHOR_ORDER.includes(r.anchor));
  for (const r of stray) {
    ctx.logger.warn(`agent:prompt 贡献 "${r.key}" 的 anchor "${r.anchor}" 不是合法锚位，本轮产物已丢弃`);
  }
}

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

import type { PromptAnchor, PromptContribution, PromptContributionView } from '@aalis/api-agent';
import type { Context } from '@aalis/core';
import { type Message, WellKnownKinds } from '@aalis/schema-message';

/** 锚位排布次序（同一轮组装内生效；语义见 agent-api 的 PromptAnchor 文档） */
const ANCHOR_ORDER: readonly PromptAnchor[] = ['identity', 'knowledge', 'context', 'turn-context', 'turn-hint'];

/**
 * 易变块（时间/会话环境/上一轮状态）的 injector 标识——buildMessages 注入、
 * 本组装器给 turn-context 定位用。两处同包，此常量是唯一事实来源。
 */
export const VOLATILE_INJECTOR = 'persona-volatile';

/**
 * 执行单个 build，可选超时。超时返回 null（本轮缺席）并 warn 点名；
 * 迟到的 settle 挂空 catch 防 unhandledRejection，clearTimeout 进 finally
 * 防悬空定时器拖住事件循环。
 */
async function buildWithTimeout(
  ctx: Context,
  key: string,
  run: () => ReturnType<PromptContribution['build']>,
  timeoutMs?: number,
): Promise<Awaited<ReturnType<PromptContribution['build']>>> {
  const p = Promise.resolve(run());
  if (!timeoutMs || timeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const winner = await Promise.race([
      p.then(out => ({ out })),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    if (winner === 'timeout') {
      p.catch(() => {});
      ctx.logger.warn(`agent:prompt 贡献 "${key}" 构建超过 ${timeoutMs}ms，本轮缺席（键未物化，下一轮重试）`);
      return null;
    }
    return winner.out;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
    case 'turn-context': {
      // 每轮取材的背景材料：落在历史结束处（缓存断点之后）、当前轮诸块之前。
      // 三级定位，取首个命中：
      // 1. 跨会话委派块之前——proactive 轮没有当前 user 消息，历史里却有
      //    旧 user 消息；若按「最后一条 user」定位会把材料 splice 进历史
      //    **内部**，既割裂转录又在 append-only 区制造新的缓存断点。
      // 2. 易变块（persona-volatile）之前——普通轮的历史/当前轮分界线。
      //    材料在此刻事实（时间/状态）之前、focus 与 turn-hint 之前：焦点
      //    指引与平台提示（「本轮上下文中的群聊历史记录」）保持与改动前相同
      //    的先行语邻接，不被整批材料隔断。
      // 3. 兜底：最后一条 user 之前；全列表无 user（空历史特殊形状）落尾。
      //
      // 注意 ANCHOR_ORDER 的「turn-context 先于 turn-hint」只在**同一次组装
      // 内**成立：工具循环第二轮才物化的迟到材料按当轮规则重新定位，与首轮
      // 已物化块的相对次序不保证。
      const delegation = messages.findIndex(m => m.metadata?.injector === WellKnownKinds.CrossSessionDelegation);
      if (delegation >= 0) return delegation;
      const volatileIdx = messages.findIndex(m => m.metadata?.injector === VOLATILE_INJECTOR);
      if (volatileIdx >= 0) return volatileIdx;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return i;
      }
      return messages.length;
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
  opts?: {
    /**
     * 单个 build 的等待上限（毫秒；缺省/0 = 不设限）。挂死的 build（如网络
     * embedding 卡住）会拖住每一次 LLM 调用——超时后该贡献本轮缺席、warn
     * 点名、其余照常物化；键未物化，下一轮会重试。执行策略属收集方，故此
     * 护栏在组装器而非内核（与 DisposableChain.disposeAsync 的逐项超时同构）。
     */
    buildTimeoutMs?: number;
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
  const timeoutMs = opts?.buildTimeoutMs;
  const built = (
    await Promise.all(
      pending.map(async ({ key, spec }): Promise<Built | null> => {
        try {
          const out = await buildWithTimeout(ctx, key, () => spec.build(view), timeoutMs);
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

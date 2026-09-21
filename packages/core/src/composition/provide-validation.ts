// ============================================================
// service-helpers.ts — provide 能力的服务登记校验
//
// 内置 provide 能力传入逻辑身份、登记选项与所需的查询/日志接口。
// 资源归属和清理登记由该能力与 Resources 负责，此处不持有激活记录。
//
// 这里不持有任何状态，副作用（查表/警告）都通过参数传入的 services/logger 反映出去。
// ============================================================

import type { ServiceContainer } from '../primitives/services.js';

import type { Logger } from '../infrastructure/logger.js';

/**
 * provide() 的 dev-mode 校验集合：
 *   1. entryId 必须以 ctxId 为前缀（逻辑身份：hasByContext 前缀查询、provides 一致性校验、
 *      api-llm 按 provider/model 解析都靠它；清理按 owner 走，不依赖前缀）
 *   2. 同一上下文重复 provide 同一服务名静默失效（容器路由按 contextId）
 *
 * 参数 explicitEntryId 区分"调用方有意覆盖 entryId"vs"使用 ctxId 默认值"——
 * 前者才触发 entryId 前缀检查与抑制重复 provide warn（有意拆粒度的语义）。
 *
 * 失败模式：均为 warn（提示但不阻断）。
 */
export function validateProvide(
  subject: { ctxId: string; name: string; entryId: string; explicitEntryId: boolean },
  deps: { services: ServiceContainer; logger: Logger },
): void {
  const { ctxId, name, entryId, explicitEntryId } = subject;
  const { services, logger } = deps;

  if (explicitEntryId && entryId !== ctxId && !entryId.startsWith(`${ctxId}/`)) {
    logger.warn(
      `服务 "${name}" 的 entryId "${entryId}" 不以 "${ctxId}/" 为前缀。` +
        `脱离前缀后 hasByContext 命不中：module.provides 一致性校验将视其为未注册，按 provider/model 的模型引用也找不到它。` +
        `推荐格式：\`\${lifecycle.id}/\${子粒度标识}\`。`,
    );
  }

  if (!explicitEntryId && services.hasByContext(name, ctxId)) {
    logger.warn(
      `服务 "${name}" 已被当前上下文 "${ctxId}" provide 过一次。容器允许多 entry，` +
        `但下游按 contextId 路由时仅能命中首个，后续注册将静默失效。` +
        `如需多实例（如多套 API key），请在插件 module 上声明 reusable=true，` +
        `然后在 config 中用 "<name>:<suffix>" 形式注册多份。` +
        `若是有意拆出多个子粒度 entry（如 per-model LLM），请传入 options.entryId。`,
    );
  }
}

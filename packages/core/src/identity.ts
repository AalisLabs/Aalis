/**
 * 用户身份标识工具函数
 *
 * 统一 userId / nickname 的使用模式，避免各插件实现不一致。
 */

/**
 * 获取消息发送者的显示标签。
 * 优先使用 nickname，回退到 userId。空字符串视为无值。
 * 返回 undefined 表示无法确定发送者（如 CLI 单用户场景）。
 */
export function getSenderLabel(nickname?: string, userId?: string): string | undefined {
  return (nickname && nickname.trim()) || userId || undefined;
}

/**
 * 将发送者标签格式化为消息前缀。
 * 有标签时返回 `[label]: content`，无标签时原样返回 content。
 */
export function prefixSender(content: string, nickname?: string, userId?: string): string {
  const label = getSenderLabel(nickname, userId);
  return label ? `[${label}]: ${content}` : content;
}

/**
 * 获取适用于 Message.name / OpenAI API name 字段的安全标识符。
 * 使用 userId（稳定不变）而非 nickname（可变）。
 * 返回 undefined 表示不设置 name 字段。
 */
export function getMessageName(userId?: string): string | undefined {
  return userId || undefined;
}

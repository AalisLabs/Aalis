/** 清洗常见凭据，保留管理端排查所需的文本与结构；不应视为任意秘密的自动识别器。 */
export function sanitizeRunLog(value: unknown, scrubText: (text: string) => string = text => text): unknown {
  const seen = new WeakSet<object>();
  const clean = (item: unknown): unknown => {
    if (typeof item === 'string')
      return scrubText(item)
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<私钥已去除>')
        .replace(/(https?:\/\/[^\s?#"'<>]*)\?[^\s"'<>]*/gi, '$1?<查询串已去除>')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<凭据已去除>@')
        .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '<认证已去除>')
        .replace(
          /(\b[\w-]*(?:api[_-]?key|token|secret|password|passwd|credential|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"'<>]+)/gi,
          '$1<已去除>',
        );
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return '<循环引用已省略>';
    seen.add(item);
    const result = Array.isArray(item)
      ? item.map(clean)
      : Object.fromEntries(
          Object.entries(item).map(([key, part]) => [
            key,
            /(?:authorization|cookie|password|passwd|token|apikey|secret|privatekey|credentials?)$/i.test(
              key.replace(/[-_\s]/g, ''),
            )
              ? '<已去除>'
              : clean(part),
          ]),
        );
    seen.delete(item);
    return result;
  };
  return clean(value);
}

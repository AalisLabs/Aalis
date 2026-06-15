// ============================================================
// doc-images.ts — 文档内嵌图片识别的纯编排逻辑
//
// 把「逐张识别 + 截断 + 文末汇总」从具体解析库（mammoth 等）解耦出来，便于单测。
// 识别函数（describe）由调用方注入，一般是 media 服务的 describeImage。
// ============================================================

/**
 * 逐张识别图片（按 maxImages 截断），单张失败不影响整体；保持原顺序，丢弃空描述。
 * @param imageUris data URI 或图片 URL 列表
 * @param describe 注入的识别函数（失败可抛错或返回空串）
 * @param maxImages 最多识别多少张（≤0 表示不识别）
 */
export async function recognizeImages(
  imageUris: string[],
  describe: (uri: string) => Promise<string>,
  maxImages: number,
): Promise<string[]> {
  const out: string[] = [];
  const limit = Math.max(0, Math.floor(maxImages));
  for (const uri of imageUris.slice(0, limit)) {
    try {
      const desc = await describe(uri);
      if (desc?.trim()) out.push(desc.trim());
    } catch {
      // 单张识别失败：跳过，不影响其余
    }
  }
  return out;
}

/** 把图片描述格式化为追加到正文末尾的小节；无描述返回空串。 */
export function formatImageSection(descriptions: string[]): string {
  if (descriptions.length === 0) return '';
  const lines = descriptions.map((d, i) => `[图片${i + 1}: ${d}]`).join('\n');
  return `\n\n--- 文档内图片 (${descriptions.length}) ---\n${lines}`;
}

// ============================================================
// doc-images.ts — 文档内嵌图片识别的纯编排逻辑
//
// 把「逐张识别 + 截断 + 文末汇总」从具体解析库（mammoth 等）解耦出来，便于单测。
// 识别函数（describe）由调用方注入，一般是 media 服务的 describeImage。
// ============================================================

interface RecognizeOptions {
  /** 最多识别多少张（≤0 表示不识别） */
  maxImages: number;
  /** 并发上限（默认 3）；控制同时在飞的视觉调用，平衡时延与速率限制 */
  concurrency?: number;
  /** 整体时间预算（毫秒，可选）；超时则返回已得到的描述，不再等待剩余 */
  timeoutMs?: number;
}

/**
 * 识别图片：按 maxImages 截断、按 concurrency 并发、可选整体超时。
 * 保持原顺序、丢弃空描述、单张失败不影响整体（best-effort，绝不抛错）。
 * @param imageUris data URI 或图片 URL 列表
 * @param describe 注入的识别函数（失败可抛错或返回空串）
 */
export async function recognizeImages(
  imageUris: string[],
  describe: (uri: string) => Promise<string>,
  opts: RecognizeOptions,
): Promise<string[]> {
  const targets = imageUris.slice(0, Math.max(0, Math.floor(opts.maxImages)));
  if (targets.length === 0) return [];
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 3));
  // 按原始下标写入，最终 filter 掉空位以保序
  const slots: Array<string | undefined> = new Array(targets.length);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= targets.length) return;
      try {
        const desc = await describe(targets[i]);
        if (desc?.trim()) slots[i] = desc.trim();
      } catch {
        // 单张识别失败：跳过，不影响其余
      }
    }
  };

  const work = Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    // 超时仅停止「等待」，已在飞的调用结果若赶在 race 前写入 slots 仍会被收集
    await Promise.race([work, new Promise<void>(resolve => setTimeout(resolve, opts.timeoutMs))]);
  } else {
    await work;
  }
  return slots.filter((d): d is string => !!d);
}

/** 把图片描述格式化为追加到正文末尾的小节；无描述返回空串。 */
export function formatImageSection(descriptions: string[]): string {
  if (descriptions.length === 0) return '';
  const lines = descriptions.map((d, i) => `[图片${i + 1}: ${d}]`).join('\n');
  return `\n\n--- 文档内图片 (${descriptions.length}) ---\n${lines}`;
}

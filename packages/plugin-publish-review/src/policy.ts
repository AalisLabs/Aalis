export const REVIEW_CATEGORIES: ReadonlySet<string> = new Set([
  '色情',
  '暴力血腥',
  '仇恨歧视',
  '政治敏感',
  '违法',
  '钓鱼或仿冒',
  '个人信息',
  '骚扰或针对个人',
]);

/** 文件处理失败不能由人工批准覆盖；内容未通过自动审核时转人工裁决。 */
export interface ReviewResult {
  verdict: 'allow' | 'unsure' | 'reject' | 'failed';
  /** 宿主给出的固定原因；模型原话只在审核详情中展示。 */
  reasons: readonly string[];
}

type ReviewDecision = { state: 'approved' | 'awaiting-owner' } | { state: 'failed'; reasons: readonly string[] };

export function decideReview(
  config: { manualReview: boolean; reviewEnabled?: boolean },
  result: ReviewResult,
): ReviewDecision {
  if (result.verdict === 'failed') return { state: 'failed', reasons: result.reasons };
  if (config.reviewEnabled === false) return { state: 'approved' };
  return !config.manualReview && result.verdict === 'allow' ? { state: 'approved' } : { state: 'awaiting-owner' };
}

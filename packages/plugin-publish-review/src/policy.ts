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

/** 文件处理失败不能由人工批准覆盖；不确定只在显式开启人工审核时交给人判断。 */
export interface ReviewResult {
  verdict: 'allow' | 'unsure' | 'reject' | 'failed';
  /** 宿主给出的固定原因；模型原话只在审核详情中展示。 */
  reasons: readonly string[];
}

type ReviewDecision =
  | { state: 'approved' | 'awaiting-owner' }
  | { state: 'rejected' | 'failed'; reasons: readonly string[] };

export function decideReview(config: { manualReview: boolean }, result: ReviewResult): ReviewDecision {
  if (result.verdict === 'failed') return { state: 'failed', reasons: result.reasons };
  if (result.verdict === 'reject') return { state: 'rejected', reasons: result.reasons };
  if (config.manualReview) return { state: 'awaiting-owner' };
  return result.verdict === 'allow' ? { state: 'approved' } : { state: 'rejected', reasons: result.reasons };
}

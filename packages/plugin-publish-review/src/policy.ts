import type { TextRef } from '@aalis/schema-i18n';
import { t } from './texts.js';

/** 自动审核的类别：值是给模型的（提示词照写）、落盘的标识，模型给出的别的类别记成「其他」；界面显示 CATEGORY_NAMES 里的名字 */
const CATEGORIES = [
  '色情',
  '暴力血腥',
  '仇恨歧视',
  '政治敏感',
  '违法',
  '钓鱼或仿冒',
  '个人信息',
  '骚扰或针对个人',
] as const;
export const REVIEW_CATEGORIES: ReadonlySet<string> = new Set(CATEGORIES);

const CATEGORY_NAMES: Readonly<Record<(typeof CATEGORIES)[number] | '其他', TextRef>> = {
  色情: t('categorySexual'),
  暴力血腥: t('categoryViolence'),
  仇恨歧视: t('categoryHate'),
  政治敏感: t('categoryPolitical'),
  违法: t('categoryIllegal'),
  钓鱼或仿冒: t('categoryPhishing'),
  个人信息: t('categoryPersonalInfo'),
  骚扰或针对个人: t('categoryHarassment'),
  其他: t('categoryOther'),
};

/** 审核理由给人看的样子：类别取显示名，宿主写的原因原样 */
export const reasonText = (reason: string | TextRef): string | TextRef =>
  typeof reason === 'string' && Object.hasOwn(CATEGORY_NAMES, reason)
    ? CATEGORY_NAMES[reason as keyof typeof CATEGORY_NAMES]
    : reason;

/** 文件处理失败不能由人工批准覆盖；内容未通过自动审核时转人工裁决。 */
export interface ReviewResult {
  verdict: 'allow' | 'unsure' | 'reject' | 'failed';
  /** 宿主给出的固定原因（文字对象）或拒绝时的类别值；模型原话只在审核详情中展示。 */
  reasons: readonly (string | TextRef)[];
}

type ReviewDecision =
  | { state: 'approved' | 'awaiting-owner' }
  | { state: 'failed'; reasons: readonly (string | TextRef)[] };

export function decideReview(
  config: { manualReview: boolean; reviewEnabled?: boolean },
  result: ReviewResult,
): ReviewDecision {
  if (result.verdict === 'failed') return { state: 'failed', reasons: result.reasons };
  if (config.reviewEnabled === false) return { state: 'approved' };
  return !config.manualReview && result.verdict === 'allow' ? { state: 'approved' } : { state: 'awaiting-owner' };
}

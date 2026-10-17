// 本插件自己的原文字典：自动审核类别的显示名、审核页的理由一栏与作品通知给人看的那句
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  categorySexual: '色情',
  categoryViolence: '暴力血腥',
  categoryHate: '仇恨歧视',
  categoryPolitical: '政治敏感',
  categoryIllegal: '违法',
  categoryPhishing: '钓鱼或仿冒',
  categoryPersonalInfo: '个人信息',
  categoryHarassment: '骚扰或针对个人',
  categoryOther: '其他',
  reasons: '{items, list}',
  // 小时数在 plural 分支里写普通参数：数字照配置原样写出（给模型的正文与旧字面量一致），英文照样分单复数
  noticeAwaitingOwner: '作品要等 owner 审核，最长 {hours, plural, other {{hours} 小时}}，有结果会再通知',
  noticeRejected: '作品未获批准，这次不发布',
  noticeExpired: '作品等 owner 审核超过 {hours, plural, other {{hours} 小时}}，这次不发布，需要的话可以重新提名',
  noticeDelayed: '作品已获准发布，但作品站暂时没能上线，owner 会处理；上线后会再通知',
  noticeIntegrityFailed: '作品已通过审核，但上线前的文件完整性校验失败，这次不发布',
  noticeUnreviewable: '作品暂时没法审核（审核步骤不可用），这次不发布',
  noticeLive: '作品已上线：{addresses, list}',
  noticeFallback: '[作品通知] {notice}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-publish-review',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

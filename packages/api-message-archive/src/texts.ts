// 本包自己的原文字典：没有地址的出站附件记成的那一句（recordOutbound 第 2 条）与四种附件的名字
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  unaddressed: '[{kind}] {name}',
  unaddressedKind: '[{kind}]',
  image: '图片',
  audio: '音频',
  video: '视频',
  file: '文件',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/api-message-archive',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

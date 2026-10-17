// 本包自己的原文字典：配置路径写成本机路径时的报错（经插件状态与「需要处理」给人看）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  hostPath:
    '这里要写 storage URI（<根名>:/<路径>，如 {example}），不能写本机路径 "{path}"；要用存储根以外的目录，先在「本地存储根」的 roots 里加一个指向它的根，并打开它的「允许写」；这个根文件工具也能访问',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-storage', language: 'zh-CN', source: SOURCE, locales: { en } });

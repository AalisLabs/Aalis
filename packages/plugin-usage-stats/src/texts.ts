// 本插件自己的原文字典：显示名与配置项，「用量统计」页的说明、列名与余额，单价写错与账本读不出的报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '用量统计',
  pricesLabel: '单价',
  pricesDescription:
    '每百万 token 的价格：键是模型 id，值依次写输入、缓存命中、输出三个价，用逗号隔开，如 deepseek-chat 写 2, 0.5, 8。填了才有费用一列，没填单价的模型不算进费用',
  currencyLabel: '币种',
  currencyDescription: '费用一列标的币种，只用于显示',
  badPrice: '单价「{model}」要写成输入、缓存命中、输出三个价，用逗号隔开，在 WebUI 或配置文件中改正后生效',
  ledgerUnreadable: '用量账本 {file} 读不出来：检查它的读写权限；要从空账本开始就把它移走后重载本插件 ← {error}',
  instanceLabel: '{name}（{instance}）',
  empty: '还没有模型调用的记录',
  description: '费用按配置里的单价估算，没填单价的模型不算在内',
  input: '输入',
  cached: '缓存命中',
  output: '输出',
  cost: '费用（{currency}）',
  byDay: '按天',
  day: '日期',
  byWeek: '按周',
  week: '周',
  byModel: '按模型',
  model: '模型',
  provider: '服务商',
  balance: '余额',
  balanceLabel: '{label}（{currency}）',
  balanceFailed: '查不到：{error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-usage-stats', language: 'zh-CN', source: SOURCE, locales: { en } });

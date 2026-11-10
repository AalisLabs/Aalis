// 本插件自己的原文字典：显示名（同为工具分组名）与分组概述（模拟盘、实盘两句）、配置项与配置报错，改变状态的请求发出之后中止或超时、结果未知的说明
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'OKX 交易',
  groupSummaryDemo: 'OKX 虚拟币交易工具集（模拟盘），提供行情查询、账户管理、下单交易等功能',
  groupSummaryLive: 'OKX 虚拟币交易工具集（实盘），提供行情查询、账户管理、下单交易等功能',
  apiKeyDescription: '在 OKX 设置中创建的 API Key',
  passphraseDescription: '创建 API 时设定的口令',
  baseUrlLabel: 'API 地址',
  baseUrlDescription: '默认实盘地址，可改为自定义域名',
  demoLabel: '模拟盘',
  demoDescription: '启用后将使用模拟交易环境，强烈建议先在模拟盘测试',
  confirmRealMoneyLabel: '确认实盘风险',
  confirmRealMoneyDescription:
    '仅当关闭模拟盘（demo:false）、用真实资金时，须显式设为 true 以确认风险；否则不暴露下单/撤单/策略/划转/提币等交易工具，仅保留查询。',
  timeoutMsLabel: '请求超时 (ms)',
  enableTradingLabel: '启用交易工具',
  enableTradingDescription: '关闭后仅保留查询类工具，不暴露下单/撤单操作',
  enableAlgoLabel: '启用策略委托',
  enableAlgoDescription: '启用止盈止损 / 计划委托工具',
  enableTransferLabel: '启用资金划转',
  enableTransferDescription: '启用资金账户划转工具',
  defaultPageLimitLabel: '分页查询默认条数',
  defaultPageLimitDescription: '查询订单/账单/成交明细等接口，LLM 未传 limit 时使用。',
  maxPageLimitLabel: '分页查询最大条数',
  maxPageLimitDescription:
    'LLM 传入的 limit 会被 cap 到该值；查到的条目整份交给模型，调大会增加单次工具结果的体积。OKX API 本身单页一般最多 100（个别接口 300）。',
  baseUrlNotPlain: 'baseUrl 需为不带用户名或密码的完整 URL',
  baseUrlHasQuery: 'baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
  abortedAfterSent: '请求已发出后中止，OKX 是否已执行未知：先查询订单、持仓或资金状态，确认之后再决定是否重试',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-okx-trading',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

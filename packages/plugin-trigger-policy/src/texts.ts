// 本插件自己的原文字典：显示名、触发服务的标签与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '触发策略',
  triggerLabel: '规则（计数/评分）',
  intervalModeLabel: '间隔模式',
  intervalFixed: 'fixed (仅按计数)',
  intervalDynamic: 'dynamic (仅按评分阈值)',
  intervalBoth: 'both (任一满足)',
  triggerOnAtLabel: '检测 @ 提及',
  triggerOnAtDescription: '@ 自己算"被点名"（戳一戳、名字同理）：点名直接开口，回合记为 immediate，点名者即授权主体。',
  triggerOnPokeLabel: '戳一戳直触发',
  triggerOnPokeDescription: '戳一戳等注意力动作视同 @ 即时触发；关闭后此类动作落回正常意愿评估，不强制回复。',
  triggerNamesLabel: '触发名别名（逗号或换行分隔）',
  muteKeywordsLabel: '禁言关键词（逗号或换行分隔）',
  muteTimeSecondsLabel: '禁言关键词命中时长（秒）',
  fixedIntervalLabel: '固定间隔（每 N 条触发）',
  activityScoreLowerLabel: '活跃指数下限',
  activityScoreUpperLabel: '活跃指数上限',
  activityDecayMinutesLabel: '阈值衰减分钟',
  scoreDecayMinutesLabel: '评分衰减分钟（0=不衰减）',
  idleTriggerScopeLabel: '闲置触发范围',
  idleScopeOff: 'off (关闭)',
  idleScopeSession: 'session (每会话独立定时)',
  idleScopePlatform: 'platform (跨会话选举)',
  idleTriggerStrategyLabel: '闲置触发策略',
  idleStrategyAllQuiet: 'all-quiet (所有会话都静默时)',
  idleStrategyFixed: 'fixed (固定间隔)',
  idleTriggerMinutesLabel: '闲置触发分钟',
  idleTriggerStyleLabel: '闲置触发风格',
  idleStyleExponential: 'exponential (指数退避)',
  idleStyleFixed: 'fixed (固定)',
  idleTriggerMaxMinutesLabel: '闲置触发上限分钟',
  idleTriggerJitterLabel: '闲置触发抖动',
  idleTriggerPromptLabel: '闲置触发系统提示',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-trigger-policy',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

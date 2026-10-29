import { REPLY_AUDIENCE_FIELD } from '@aalis/api-gateway';
import type {} from '@aalis/api-session-settings'; // 按会话字段的声明成员经 declaration merging 并入 SessionFieldSpec
import { type ConfigOf, defineConfig, type SessionFieldsOf } from '@aalis/schema-config';
import { t } from './texts.js';

/** 可按会话设的参数：只适用于房间，收在高级里 */
const ROOM = { appliesTo: ['room'], prominence: 'advanced' } as const;

// 生效范围与判定、闲置的参数都可按会话设（平台档、平台类型档、场所、本会话），每条消息按会话现读；
// 闲置触发策略管的是跨会话选举的整体节奏，只在插件配置里
export const configSchema = defineConfig({
  audience: { ...REPLY_AUDIENCE_FIELD, session: { appliesTo: ['room'], prominence: 'common' } },
  intervalMode: {
    type: 'select',
    label: t('intervalModeLabel'),
    default: 'both',
    options: [
      { label: t('intervalFixed'), value: 'fixed' },
      { label: t('intervalDynamic'), value: 'dynamic' },
      { label: t('intervalBoth'), value: 'both' },
    ],
    session: ROOM,
  },
  triggerOnAt: {
    type: 'boolean',
    label: t('triggerOnAtLabel'),
    default: true,
    description: t('triggerOnAtDescription'),
    session: ROOM,
  },
  triggerOnPoke: {
    type: 'boolean',
    label: t('triggerOnPokeLabel'),
    default: true,
    description: t('triggerOnPokeDescription'),
    session: ROOM,
  },
  triggerNames: { type: 'string', label: t('triggerNamesLabel'), default: '', session: ROOM },
  muteKeywords: { type: 'string', label: t('muteKeywordsLabel'), default: '', session: ROOM },
  muteTimeSeconds: {
    type: 'number',
    label: t('muteTimeSecondsLabel'),
    default: 60,
    session: ROOM,
  },
  fixedInterval: {
    type: 'number',
    label: t('fixedIntervalLabel'),
    default: 5,
    session: ROOM,
  },
  activityScoreLower: { type: 'number', label: t('activityScoreLowerLabel'), default: 0.3, session: ROOM },
  activityScoreUpper: { type: 'number', label: t('activityScoreUpperLabel'), default: 0.85, session: ROOM },
  activityDecayMinutes: {
    type: 'number',
    label: t('activityDecayMinutesLabel'),
    default: 10,
    session: ROOM,
  },
  scoreDecayMinutes: {
    type: 'number',
    label: t('scoreDecayMinutesLabel'),
    default: 0,
    session: ROOM,
  },
  idleTriggerScope: {
    type: 'select',
    label: t('idleTriggerScopeLabel'),
    default: 'off',
    options: [
      { label: t('idleScopeOff'), value: 'off' },
      { label: t('idleScopeSession'), value: 'session' },
      { label: t('idleScopePlatform'), value: 'platform' },
    ],
    session: ROOM,
  },
  idleTriggerStrategy: {
    type: 'select',
    label: t('idleTriggerStrategyLabel'),
    default: 'all-quiet',
    options: [
      { label: t('idleStrategyAllQuiet'), value: 'all-quiet' },
      { label: t('idleStrategyFixed'), value: 'fixed' },
    ],
  },
  idleTriggerMinutes: {
    type: 'number',
    label: t('idleTriggerMinutesLabel'),
    default: 180,
    session: ROOM,
  },
  idleTriggerStyle: {
    type: 'select',
    label: t('idleTriggerStyleLabel'),
    default: 'exponential',
    options: [
      { label: t('idleStyleExponential'), value: 'exponential' },
      { label: t('idleStyleFixed'), value: 'fixed' },
    ],
    session: ROOM,
  },
  idleTriggerMaxMinutes: {
    type: 'number',
    label: t('idleTriggerMaxMinutesLabel'),
    default: 1440,
    session: ROOM,
  },
  idleTriggerJitter: { type: 'boolean', label: t('idleTriggerJitterLabel'), default: true, session: ROOM },
  idleTriggerPrompt: {
    type: 'string',
    label: t('idleTriggerPromptLabel'),
    default: '',
    session: ROOM,
  },
});

/** 插件配置（不按会话）：闲置触发策略 */
export type TriggerPolicyConfig = ConfigOf<typeof configSchema>;

type SessionFields = SessionFieldsOf<typeof configSchema>;

/** 一个会话此刻的参数：表单文本拆成了名字列表 */
export type TriggerPolicySettings = Omit<SessionFields, 'triggerNames' | 'muteKeywords'> & {
  triggerNames: string[];
  muteKeywords: string[];
};

function splitNames(value: string): string[] {
  return value
    .split(/[,\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 按会话读到的参数派生：表单文本拆成名字列表，禁言时长取正整数（不是正数的取默认） */
export function normalizeSettings(fields: SessionFields): TriggerPolicySettings {
  return {
    ...fields,
    triggerNames: splitNames(fields.triggerNames),
    muteKeywords: splitNames(fields.muteKeywords),
    muteTimeSeconds:
      fields.muteTimeSeconds > 0 ? Math.floor(fields.muteTimeSeconds) : configSchema.muteTimeSeconds.default,
  };
}

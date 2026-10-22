import { REPLY_AUDIENCE_FIELD } from '@aalis/api-gateway';
import type {} from '@aalis/api-session-settings'; // 按会话字段的声明成员经 declaration merging 并入 SessionFieldSpec
import { type ConfigOf, defineConfig, type SessionFieldsOf } from '@aalis/schema-config';
import type {} from '@aalis/schema-i18n'; // 生效范围的称呼是文字对象：导出的 configSchema 的类型里有 TextRef

/** 可按会话设的参数：只适用于房间，收在高级里 */
const ROOM = { appliesTo: ['room'], prominence: 'advanced' } as const;

// 生效范围与判定、闲置的参数都可按会话设（平台档、平台类型档、场所、本会话），每条消息按会话现读；
// 闲置触发策略管的是跨会话选举的整体节奏，只在插件配置里
export const configSchema = defineConfig({
  audience: { ...REPLY_AUDIENCE_FIELD, session: { appliesTo: ['room'], prominence: 'common' } },
  intervalMode: {
    type: 'select',
    label: '间隔模式',
    default: 'both',
    options: [
      { label: 'fixed (仅按计数)', value: 'fixed' },
      { label: 'dynamic (仅按评分阈值)', value: 'dynamic' },
      { label: 'both (任一满足)', value: 'both' },
    ],
    session: ROOM,
  },
  triggerOnAt: {
    type: 'boolean',
    label: '检测 @ 提及',
    default: true,
    description: '@ 自己算"被点名"（戳一戳、名字同理）：点名直接开口，回合记为 immediate，点名者即授权主体。',
    session: ROOM,
  },
  triggerOnPoke: {
    type: 'boolean',
    label: '戳一戳直触发',
    default: true,
    description: '戳一戳等注意力动作视同 @ 即时触发；关闭后此类动作落回正常意愿评估，不强制回复。',
    session: ROOM,
  },
  triggerNames: { type: 'string', label: '触发名别名（逗号或换行分隔）', default: '', session: ROOM },
  muteKeywords: { type: 'string', label: '禁言关键词（逗号或换行分隔）', default: '', session: ROOM },
  muteTimeSeconds: {
    type: 'number',
    label: '禁言关键词命中时长（秒）',
    default: 60,
    session: ROOM,
  },
  fixedInterval: {
    type: 'number',
    label: '固定间隔（每 N 条触发）',
    default: 5,
    session: ROOM,
  },
  activityScoreLower: { type: 'number', label: '活跃指数下限', default: 0.3, session: ROOM },
  activityScoreUpper: { type: 'number', label: '活跃指数上限', default: 0.85, session: ROOM },
  activityDecayMinutes: {
    type: 'number',
    label: '阈值衰减分钟',
    default: 10,
    session: ROOM,
  },
  scoreDecayMinutes: {
    type: 'number',
    label: '评分衰减分钟（0=不衰减）',
    default: 0,
    session: ROOM,
  },
  idleTriggerScope: {
    type: 'select',
    label: '闲置触发范围',
    default: 'off',
    options: [
      { label: 'off (关闭)', value: 'off' },
      { label: 'session (每会话独立定时)', value: 'session' },
      { label: 'platform (跨会话选举)', value: 'platform' },
    ],
    session: ROOM,
  },
  idleTriggerStrategy: {
    type: 'select',
    label: '闲置触发策略',
    default: 'all-quiet',
    options: [
      { label: 'all-quiet (所有会话都静默时)', value: 'all-quiet' },
      { label: 'fixed (固定间隔)', value: 'fixed' },
    ],
  },
  idleTriggerMinutes: {
    type: 'number',
    label: '闲置触发分钟',
    default: 180,
    session: ROOM,
  },
  idleTriggerStyle: {
    type: 'select',
    label: '闲置触发风格',
    default: 'exponential',
    options: [
      { label: 'exponential (指数退避)', value: 'exponential' },
      { label: 'fixed (固定)', value: 'fixed' },
    ],
    session: ROOM,
  },
  idleTriggerMaxMinutes: {
    type: 'number',
    label: '闲置触发上限分钟',
    default: 1440,
    session: ROOM,
  },
  idleTriggerJitter: { type: 'boolean', label: '闲置触发抖动', default: true, session: ROOM },
  idleTriggerPrompt: {
    type: 'string',
    label: '闲置触发系统提示',
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

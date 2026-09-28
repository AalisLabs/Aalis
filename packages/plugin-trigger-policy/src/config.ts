import { type ConfigOf, defineConfig } from '@aalis/schema-config';

export const configSchema = defineConfig({
  scopes: {
    type: 'multiselect',
    label: '生效作用域',
    default: ['*:group'],
    dynamicOptions: 'gateway-scopes',
    allowCustom: true,
    description:
      '格式 platform:sessionType，支持通配 *；onebot:group / *:group / onebot:* / *。默认 *:group；默认作用域不含 WebUI/CLI，如需纳入，在这里显式添加。',
  },
  intervalMode: {
    type: 'select',
    label: '间隔模式',
    default: 'both',
    options: [
      { label: 'fixed (仅按计数)', value: 'fixed' },
      { label: 'dynamic (仅按评分阈值)', value: 'dynamic' },
      { label: 'both (任一满足)', value: 'both' },
    ],
  },
  triggerOnAt: {
    type: 'boolean',
    label: '检测 @ 提及',
    default: true,
    description: '@ 自己算"被点名"（戳一戳、名字同理）：点名直接开口，回合记为 immediate，点名者即授权主体。',
  },
  triggerOnPoke: {
    type: 'boolean',
    label: '戳一戳直触发',
    default: true,
    description: '戳一戳等注意力动作视同 @ 即时触发；关闭后此类动作落回正常意愿评估，不强制回复。',
  },
  triggerNames: { type: 'string', label: '触发名别名（逗号或换行分隔）', default: '' },
  muteKeywords: { type: 'string', label: '禁言关键词（逗号或换行分隔）', default: '' },
  muteTimeSeconds: {
    type: 'number',
    label: '禁言关键词命中时长（秒）',
    default: 60,
  },
  fixedInterval: {
    type: 'number',
    label: '固定间隔（每 N 条触发）',
    default: 5,
  },
  activityScoreLower: { type: 'number', label: '活跃指数下限', default: 0.3 },
  activityScoreUpper: { type: 'number', label: '活跃指数上限', default: 0.85 },
  activityDecayMinutes: {
    type: 'number',
    label: '阈值衰减分钟',
    default: 10,
  },
  scoreDecayMinutes: {
    type: 'number',
    label: '评分衰减分钟（0=不衰减）',
    default: 0,
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
  },
  idleTriggerStyle: {
    type: 'select',
    label: '闲置触发风格',
    default: 'exponential',
    options: [
      { label: 'exponential (指数退避)', value: 'exponential' },
      { label: 'fixed (固定)', value: 'fixed' },
    ],
  },
  idleTriggerMaxMinutes: {
    type: 'number',
    label: '闲置触发上限分钟',
    default: 1440,
  },
  idleTriggerJitter: { type: 'boolean', label: '闲置触发抖动', default: true },
  idleTriggerPrompt: {
    type: 'string',
    label: '闲置触发系统提示',
    default: '',
  },
  overrides: {
    type: 'array',
    label: '分作用域覆盖',
    description:
      '每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段；字段留空（或不填）= 沿用上方默认，不会被覆盖为 0/空。写一条 override 自动启用该 scope。',
    default: [],
    items: {
      scope: {
        type: 'string',
        label: '作用域',
        description: '格式 platform:sessionType[:targetId]，支持 *',
        required: true,
      },
      intervalMode: {
        type: 'select',
        label: '间隔模式',
        options: [
          { label: 'fixed', value: 'fixed' },
          { label: 'dynamic', value: 'dynamic' },
          { label: 'both', value: 'both' },
        ],
      },
      triggerOnAt: { type: 'boolean', label: '检测 @ 提及' },
      triggerOnPoke: { type: 'boolean', label: '戳一戳直触发' },
      triggerNames: { type: 'string', label: '触发名别名（逗号或换行分隔）' },
      muteKeywords: { type: 'string', label: '禁言关键词（逗号或换行分隔）' },
      muteTimeSeconds: { type: 'number', label: '禁言关键词时长（秒）' },
      fixedInterval: { type: 'number', label: '固定间隔（每 N 条触发）' },
      activityScoreLower: { type: 'number', label: '活跃指数下限' },
      activityScoreUpper: { type: 'number', label: '活跃指数上限' },
      activityDecayMinutes: { type: 'number', label: '阈值衰减分钟' },
      scoreDecayMinutes: { type: 'number', label: '评分衰减分钟' },
      idleTriggerScope: {
        type: 'select',
        label: '闲置触发范围',
        options: [
          { label: 'off', value: 'off' },
          { label: 'session', value: 'session' },
          { label: 'platform', value: 'platform' },
        ],
      },
      idleTriggerMinutes: { type: 'number', label: '闲置触发分钟' },
      idleTriggerStyle: {
        type: 'select',
        label: '闲置触发风格',
        options: [
          { label: 'exponential', value: 'exponential' },
          { label: 'fixed', value: 'fixed' },
        ],
      },
      idleTriggerMaxMinutes: { type: 'number', label: '闲置触发上限分钟' },
      idleTriggerJitter: { type: 'boolean', label: '闲置触发抖动' },
      idleTriggerPrompt: { type: 'string', label: '闲置触发系统提示' },
    },
  },
});

type ParsedConfig = ConfigOf<typeof configSchema>;
export type TriggerScopeOverride = Omit<ParsedConfig['overrides'][number], 'triggerNames' | 'muteKeywords'> & {
  triggerNames?: string[];
  muteKeywords?: string[];
};
export type TriggerPolicyConfig = Omit<ParsedConfig, 'triggerNames' | 'muteKeywords' | 'overrides'> & {
  triggerNames: string[];
  muteKeywords: string[];
  overrides: TriggerScopeOverride[];
};

function splitNames(value: string): string[] {
  return value
    .split(/[,\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 表单文本派生为名字列表；覆盖项的留空字段不覆盖顶层。 */
export function normalizeConfig(cfg: ParsedConfig, logger?: { warn(message: string): void }): TriggerPolicyConfig {
  const scopes = cfg.scopes.filter(s => s.trim() !== '');
  if (scopes.length !== cfg.scopes.length) logger?.warn('配置项 scopes 含空白作用域，已忽略');
  const overrides: TriggerScopeOverride[] = [];
  for (const item of cfg.overrides) {
    const scope = item.scope.trim();
    if (!scope) {
      logger?.warn('配置项 overrides 中有一项 scope 只含空白，已忽略该项');
      continue;
    }
    const { triggerNames, muteKeywords, muteTimeSeconds, idleTriggerPrompt, ...rest } = item;
    const normalized: TriggerScopeOverride = { ...rest, scope };
    if (triggerNames?.trim()) normalized.triggerNames = splitNames(triggerNames);
    if (muteKeywords?.trim()) normalized.muteKeywords = splitNames(muteKeywords);
    if (muteTimeSeconds !== undefined && muteTimeSeconds > 0) normalized.muteTimeSeconds = Math.floor(muteTimeSeconds);
    if (idleTriggerPrompt) normalized.idleTriggerPrompt = idleTriggerPrompt;
    overrides.push(normalized);
  }
  return {
    ...cfg,
    scopes,
    overrides,
    triggerNames: splitNames(cfg.triggerNames),
    muteKeywords: splitNames(cfg.muteKeywords),
    muteTimeSeconds: cfg.muteTimeSeconds > 0 ? Math.floor(cfg.muteTimeSeconds) : configSchema.muteTimeSeconds.default,
  };
}

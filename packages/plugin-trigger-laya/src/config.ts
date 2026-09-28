import { type ConfigOf, defineConfig } from '@aalis/schema-config';

export const configSchema = defineConfig({
  scopes: {
    type: 'multiselect',
    label: '生效作用域',
    default: ['*:group'],
    dynamicOptions: 'gateway-scopes',
    allowCustom: true,
    description:
      '格式 platform:sessionType，支持通配 *。作用域外的消息直接放行，由后面的流控与 agent 照常处理（默认不含私聊：模型只用群聊训练）。',
  },
  threshold: {
    type: 'number',
    label: '开口阈值',
    description: 'logit ≥ 阈值即开口。留空 = 用侧车返回的模型阈值（随模型版本给出）。',
  },
  triggerOnAt: {
    type: 'boolean',
    label: '检测 @ 提及',
    default: true,
    description:
      '@ 自己算"被点名"（戳一戳、名字同理）。点名不强制开口，由模型判定；开口的回合记为 immediate，点名者即授权主体。判定不可用时只回点名。',
  },
  triggerOnPoke: {
    type: 'boolean',
    label: '戳一戳算点名',
    default: true,
  },
  triggerNames: { type: 'string', label: '点名别名（逗号或换行分隔）', default: '' },
  muteKeywords: { type: 'string', label: '禁言关键词（逗号或换行分隔）', default: '' },
  muteTimeSeconds: {
    type: 'number',
    label: '禁言关键词命中时长（秒）',
    default: 60,
  },
  mediaWaitMs: {
    type: 'number',
    label: '附件识别等待上限（毫秒）',
    default: 8000,
    description: '带图片等附件的消息先等识别写好描述再交给模型；超时照常判定，识别在后台继续。',
  },
  endpoint: { type: 'string', label: '侧车地址', default: 'http://127.0.0.1:17878', onInvalid: 'error' },
  sidecarDir: {
    type: 'string',
    label: '侧车目录（由本插件托管）',
    default: '',
    description:
      '侧车 laya-listener 所在目录的绝对路径。填了则本插件生效时自己拉起侧车、退出后重启，不再生效或停用时关掉，' +
      '端口取侧车地址的（地址须为 http://127.0.0.1:<端口>）；留空 = 侧车由外部运行，只按侧车地址连接。',
  },
  timeoutMs: {
    type: 'number',
    label: '请求超时（毫秒）',
    default: 1000,
    description: '含读完响应体。超时计一次失败，本条按兜底只回点名。',
  },
  historyRows: {
    type: 'number',
    label: '历史行数',
    default: 80,
    description: '窗口的行数，只算 user / assistant 且正文是字符串的行：从 memory 多取一倍，过滤后留最后这么多行。',
  },
  priority: {
    type: 'number',
    label: '优先级 (越大越优先)',
    default: -10,
    description: 'trigger 服务按偏好 > 优先级 > 注册顺序选出生效的触发插件；规则判定 trigger-policy 为 0。',
  },
  overrides: {
    type: 'array',
    label: '分作用域覆盖',
    description:
      '每项 {scope: "platform:sessionType[:targetId]", threshold} 仅在该 scope 命中时覆盖阈值，最具体者胜；留空 = 沿用上方设置。写一条 override 自动启用该 scope。',
    default: [],
    items: {
      scope: {
        type: 'string',
        label: '作用域',
        description: '格式 platform:sessionType[:targetId]，支持 *',
        required: true,
      },
      threshold: { type: 'number', label: '开口阈值' },
    },
  },
});

type ParsedConfig = ConfigOf<typeof configSchema>;
type LayaConfig = Omit<ParsedConfig, 'triggerNames' | 'muteKeywords'> & {
  triggerNames: string[];
  muteKeywords: string[];
};

function splitNames(value: string): string[] {
  return value
    .split(/[,\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 文本名单与运行参数在解析后派生；无效地址在注册服务或托管侧车前拒绝。 */
export function normalizeConfig(cfg: ParsedConfig, logger?: { warn(message: string): void }): LayaConfig {
  const scopes = cfg.scopes.filter(s => s.trim() !== '');
  if (scopes.length !== cfg.scopes.length) logger?.warn('配置项 scopes 含空白作用域，已忽略');
  const overrides: ParsedConfig['overrides'] = [];
  for (const item of cfg.overrides) {
    const scope = item.scope.trim();
    if (scope) overrides.push({ ...item, scope });
    else logger?.warn('配置项 overrides 中有一项 scope 只含空白，已忽略该项');
  }
  const endpoint = cfg.endpoint.trim().replace(/\/+$/, '') || configSchema.endpoint.default;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('plugin-trigger-laya 配置错误: endpoint 须为 HTTP 地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash) {
    throw new Error('plugin-trigger-laya 配置错误: endpoint 须为 HTTP 地址');
  }
  return {
    ...cfg,
    scopes,
    overrides,
    endpoint,
    sidecarDir: cfg.sidecarDir.trim().replace(/(.)\/+$/, '$1'),
    triggerNames: splitNames(cfg.triggerNames),
    muteKeywords: splitNames(cfg.muteKeywords),
    muteTimeSeconds: cfg.muteTimeSeconds > 0 ? Math.floor(cfg.muteTimeSeconds) : configSchema.muteTimeSeconds.default,
    mediaWaitMs: cfg.mediaWaitMs >= 0 ? cfg.mediaWaitMs : configSchema.mediaWaitMs.default,
    timeoutMs: cfg.timeoutMs > 0 ? cfg.timeoutMs : configSchema.timeoutMs.default,
    historyRows:
      Number.isInteger(cfg.historyRows) && cfg.historyRows > 0 ? cfg.historyRows : configSchema.historyRows.default,
  };
}

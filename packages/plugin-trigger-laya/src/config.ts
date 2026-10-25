import { REPLY_AUDIENCE_FIELD } from '@aalis/api-gateway';
import type {} from '@aalis/api-session-settings'; // 按会话字段的声明成员经 declaration merging 并入 SessionFieldSpec
import { type ConfigOf, defineConfig } from '@aalis/schema-config';
import { t } from './texts.js';

// 生效范围与开口阈值可按会话设（平台档、平台类型档、场所、本会话），每条消息按会话现读；其余是插件配置
export const configSchema = defineConfig({
  // 范围外的消息直接放行，由后面的流控与 agent 照常处理（默认不含私聊：判别模型只用群聊训练过，频道里同样没有训练依据）
  audience: { ...REPLY_AUDIENCE_FIELD, session: { appliesTo: ['room'], prominence: 'common' } },
  threshold: {
    type: 'number',
    label: '开口阈值',
    description: 'logit ≥ 阈值即开口。留空 = 用侧车返回的模型阈值（随模型版本给出）。',
    session: { appliesTo: ['room'], prominence: 'advanced', unset: t('thresholdUnset') },
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
export function normalizeConfig(cfg: ParsedConfig): LayaConfig {
  const endpoint = cfg.endpoint.trim().replace(/\/+$/, '') || configSchema.endpoint.default;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('plugin-trigger-laya 配置错误: endpoint 须为 HTTP 地址');
  }
  // 插件在 endpoint 后面拼路径，带查询串或片段（含末尾单个 ?）时拼出来的地址是坏的，所以按原文判
  if (/[?#]/.test(endpoint)) {
    throw new Error(
      'plugin-trigger-laya 配置错误: endpoint 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
    );
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('plugin-trigger-laya 配置错误: endpoint 须为 HTTP 地址');
  }
  return {
    ...cfg,
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

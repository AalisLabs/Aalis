import { REPLY_AUDIENCE_FIELD } from '@aalis/api-gateway';
import type {} from '@aalis/api-session-settings'; // 按会话字段的声明成员经 declaration merging 并入 SessionFieldSpec
import { type ConfigOf, configError, defineConfig } from '@aalis/schema-config';
import { t } from './texts.js';

// 生效范围与开口阈值可按会话设（平台档、平台类型档、场所、本会话），每条消息按会话现读；其余是插件配置
export const configSchema = defineConfig({
  // 范围外的消息直接放行，由后面的流控与 agent 照常处理（默认不含私聊：判别模型只用群聊训练过，频道里同样没有训练依据）
  audience: { ...REPLY_AUDIENCE_FIELD, session: { appliesTo: ['room'], prominence: 'common' } },
  threshold: {
    type: 'number',
    label: t('thresholdLabel'),
    description: t('thresholdDescription'),
    session: { appliesTo: ['room'], prominence: 'advanced', unset: t('thresholdUnset') },
  },
  triggerOnAt: {
    type: 'boolean',
    label: t('triggerOnAtLabel'),
    default: true,
    description: t('triggerOnAtDescription'),
  },
  triggerOnPoke: {
    type: 'boolean',
    label: t('triggerOnPokeLabel'),
    default: true,
  },
  triggerNames: { type: 'string', label: t('triggerNamesLabel'), default: '' },
  muteKeywords: { type: 'string', label: t('muteKeywordsLabel'), default: '' },
  muteTimeSeconds: {
    type: 'number',
    label: t('muteTimeSecondsLabel'),
    default: 60,
  },
  mediaWaitMs: {
    type: 'number',
    label: t('mediaWaitMsLabel'),
    default: 8000,
    description: t('mediaWaitMsDescription'),
  },
  endpoint: { type: 'string', label: t('endpointLabel'), default: 'http://127.0.0.1:17878', onInvalid: 'error' },
  sidecarDir: {
    type: 'string',
    label: t('sidecarDirLabel'),
    default: '',
    description: t('sidecarDirDescription'),
  },
  timeoutMs: {
    type: 'number',
    label: t('timeoutMsLabel'),
    default: 1000,
    description: t('timeoutMsDescription'),
  },
  historyRows: {
    type: 'number',
    label: t('historyRowsLabel'),
    default: 80,
    description: t('historyRowsDescription'),
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
    throw configError(t('endpointNotHttp'));
  }
  // 插件在 endpoint 后面拼路径，带查询串或片段（含末尾单个 ?）时拼出来的地址是坏的，所以按原文判
  if (/[?#]/.test(endpoint)) {
    throw configError(t('endpointQuery'));
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw configError(t('endpointNotHttp'));
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

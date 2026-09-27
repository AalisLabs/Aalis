// ============================================================
// 配置：全局上限、换日时区、白纸的默认属性与具名白纸
//
// 配置表单只能表达字段、分组与「数组项全是基础字段」的对象数组，所以白纸的属性拍平成 papers[] 项的
// 同名字段；具名白纸没写的字段取 defaults 分组。房间级的开关与上限在会话配置里（paperEnabled 等），
// 不在这里。
// ============================================================

import type { EgressCeiling } from '@aalis/api-remote-agent';
import type { Logger } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';

const PAPER_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,31}$';
const EGRESS_CEILINGS: readonly EgressCeiling[] = ['none', 'allowlist', 'open'];

const EGRESS_OPTIONS = [
  { label: '不出网', value: 'none' },
  { label: '只到白名单', value: 'allowlist' },
  { label: '不限', value: 'open' },
];

const DEFAULT_EGRESS: EgressCeiling = 'allowlist';
const DEFAULT_MAX_WAITING = 5;
const DEFAULT_RESERVE_CENTS = 50;
const MB = 1024 * 1024;

/** 数值型配置的缺省值：全局的与白纸属性的 */
const NUMBER_DEFAULTS = {
  maxRunMinutes: 20,
  sendHtmlMaxMB: 5,
  pendingHintHours: 24,
  reconcileMinutes: 60,
  taskRetentionDays: 30,
} as const;
const SPEC_NUMBER_DEFAULTS = {
  clearAfterDays: 30,
  rotateAfterCents: 300,
  rotateAfterInputTokens: 200_000,
  idleArchiveMinutes: 30,
} as const;
const ARTIFACT_DEFAULTS = { maxFileMB: 25, maxRunMB: 50, maxRunFiles: 200, maxBundleMB: 50, maxPaperMB: 2048 } as const;

export const configSchema: ConfigSchema = {
  globalDailyCents: {
    type: 'number',
    label: '全局每天金额上限（美分）',
    default: 0,
    min: 0,
    description: '所有白纸合计每天能花多少；0 即不开远端任务。房间自己的上限在会话配置 remoteAgentRoomDailyCents',
  },
  reserveDefaultCents: {
    type: 'number',
    label: '默认预留额（美分）',
    default: DEFAULT_RESERVE_CENTS,
    min: 1,
    description: '受理一件任务时先按这块白纸最近 5 轮的平均费用预留额度，没有历史时用这个值',
  },
  budgetTimeZone: {
    type: 'string',
    label: '换日时区',
    description: '每日上限在这个时区的 0 点换日（IANA 名，如 Asia/Shanghai）；留空取宿主进程的本地时区',
  },
  maxRunMinutes: {
    type: 'number',
    label: '单轮时长上限（分钟）',
    default: NUMBER_DEFAULTS.maxRunMinutes,
    min: 1,
    description: '远端一轮从开轮起超过这么久就取消；由计时器执行，远端只发心跳时也照样到点',
  },
  sendHtml: {
    type: 'boolean',
    label: '允许发单个网页',
    default: true,
    description: 'paper_send 能否把单个 HTML 成品作为文件发回房间（在对方本地以 file:// 打开，没有沙箱）',
  },
  sendHtmlMaxMB: {
    type: 'number',
    label: '单个网页的发送上限（MB）',
    default: NUMBER_DEFAULTS.sendHtmlMaxMB,
    min: 1,
  },
  pendingHintHours: {
    type: 'number',
    label: '待交付提示保留（小时）',
    default: NUMBER_DEFAULTS.pendingHintHours,
    min: 1,
    description: '已完成、成品还没发回的任务，结束后这么久之内每次对话都提示她用 paper_send 发回',
  },
  reconcileMinutes: {
    type: 'number',
    label: '定期检查间隔（分钟）',
    default: NUMBER_DEFAULTS.reconcileMinutes,
    min: 10,
    description: '对账（找账本外的轮次与代理）、闲置归档与定期清空的检查间隔',
  },
  taskRetentionDays: {
    type: 'number',
    label: '任务记录保留天数',
    default: NUMBER_DEFAULTS.taskRetentionDays,
    min: 1,
    description: '已结束的任务在账本里保留多久；轮次记录另按代理保留到代理删除为止',
  },
  artifacts: {
    label: '成品上限',
    description: '取回成品时的上限；超过的文件拒收',
    fields: {
      maxFileMB: { type: 'number', label: '单个文件（MB）', default: ARTIFACT_DEFAULTS.maxFileMB, min: 1 },
      maxRunMB: { type: 'number', label: '每轮合计（MB）', default: ARTIFACT_DEFAULTS.maxRunMB, min: 1 },
      maxRunFiles: {
        type: 'number',
        label: '每轮文件数',
        default: ARTIFACT_DEFAULTS.maxRunFiles,
        min: 1,
        integer: true,
      },
      maxBundleMB: { type: 'number', label: '工程包（MB）', default: ARTIFACT_DEFAULTS.maxBundleMB, min: 1 },
      maxPaperMB: {
        type: 'number',
        label: '每块白纸目录总占用（MB）',
        default: ARTIFACT_DEFAULTS.maxPaperMB,
        min: 1,
        description: '成品在清空之前一直留在本机；超过时拒收余下的文件并停开这块白纸',
      },
    },
  },
  defaults: {
    label: '白纸默认属性',
    description: '不写名字的房间白纸用这组；具名白纸没写的字段也取这组',
    fields: {
      remoteAgentType: {
        type: 'string',
        label: '远端代理类型',
        default: '',
        description: '远端代理插件实例 id（如 @aalis/plugin-remote-agent-cursor）；空即不开远端任务',
      },
      remoteAgentEgress: {
        type: 'select',
        label: '出网上限',
        default: DEFAULT_EGRESS,
        options: EGRESS_OPTIONS,
        description: '提供者报告的出网方式超过它时不开远端任务；报告「未知」按不限计',
      },
      maxWaiting: {
        type: 'number',
        label: '未结束任务上限',
        default: DEFAULT_MAX_WAITING,
        min: 1,
        integer: true,
        description: '一块白纸上排队与进行中的任务合计不超过这个数',
      },
      maxPerUser: {
        type: 'number',
        label: '每人未结束任务上限',
        min: 1,
        integer: true,
        description: '同一人在一块白纸上未结束的任务数；留空即不按人限制',
      },
      clearAfterDays: {
        type: 'number',
        label: '定期清空（天）',
        default: SPEC_NUMBER_DEFAULTS.clearAfterDays,
        min: 1,
        description: '距上次清空这么久、且白纸空闲时，删除远端代理与白纸目录（任务记录保留）',
      },
      rotateAfterCents: {
        type: 'number',
        label: '换新：代理累计花费（美分）',
        default: SPEC_NUMBER_DEFAULTS.rotateAfterCents,
        min: 1,
        description: '代理累计花费超过它，下一件任务建新代理（只重置对话，工程包照常带过去）',
      },
      rotateAfterInputTokens: {
        type: 'number',
        label: '换新：上一轮上下文（token）',
        default: SPEC_NUMBER_DEFAULTS.rotateAfterInputTokens,
        min: 1,
        integer: true,
        description: '上一轮的输入加缓存读取超过它，下一件任务建新代理',
      },
      idleArchiveMinutes: {
        type: 'number',
        label: '闲置归档（分钟）',
        default: SPEC_NUMBER_DEFAULTS.idleArchiveMinutes,
        min: 1,
        description: '代理最后一轮结束后这么久没有新任务就归档（在定期检查时执行）',
      },
    },
  },
  papers: {
    type: 'array',
    label: '具名白纸',
    default: [],
    description: '房间在会话配置里写 paperName 即用这里的同名白纸；几个房间写同一个名字就共用一块',
    items: {
      name: {
        type: 'string',
        label: '名字',
        required: true,
        pattern: PAPER_NAME_PATTERN,
        description: '小写字母、数字与连字符，最长 32 个字符',
      },
      remoteAgentType: { type: 'string', label: '远端代理类型', description: '留空取默认属性' },
      remoteAgentEgress: {
        type: 'select',
        label: '出网上限',
        options: [{ label: '取默认属性', value: '' }, ...EGRESS_OPTIONS],
      },
      maxWaiting: { type: 'number', label: '未结束任务上限', min: 1, integer: true, description: '留空取默认属性' },
      maxPerUser: { type: 'number', label: '每人未结束任务上限', min: 1, integer: true, description: '留空取默认属性' },
      clearAfterDays: { type: 'number', label: '定期清空（天）', min: 1, description: '留空取默认属性' },
      rotateAfterCents: { type: 'number', label: '换新：代理累计花费（美分）', min: 1, description: '留空取默认属性' },
      rotateAfterInputTokens: {
        type: 'number',
        label: '换新：上一轮上下文（token）',
        min: 1,
        integer: true,
        description: '留空取默认属性',
      },
      idleArchiveMinutes: { type: 'number', label: '闲置归档（分钟）', min: 1, description: '留空取默认属性' },
    },
  },
};

/** 一块白纸的属性 */
export interface PaperSpec {
  /** 具名白纸的名字；房间白纸没有 */
  name?: string;
  /** 远端代理插件实例 id；空即不开远端任务 */
  remoteAgentType: string;
  remoteAgentEgress: EgressCeiling;
  maxWaiting: number;
  /** 缺省即不按人限制 */
  maxPerUser?: number;
  clearAfterDays: number;
  rotateAfterCents: number;
  rotateAfterInputTokens: number;
  idleArchiveMinutes: number;
}

/** 取回成品的上限（字节与文件数） */
export interface ArtifactCaps {
  maxFileBytes: number;
  maxRunBytes: number;
  maxRunFiles: number;
  maxBundleBytes: number;
  /** 每块白纸目录的总占用 */
  maxPaperBytes: number;
}

export interface PaperConfig {
  globalDailyCents: number;
  reserveDefaultCents: number;
  /** 缺省取宿主进程的本地时区 */
  budgetTimeZone?: string;
  maxRunMinutes: number;
  /** paper_send 能否发单个 HTML */
  sendHtml: boolean;
  sendHtmlMaxBytes: number;
  pendingHintHours: number;
  reconcileMinutes: number;
  taskRetentionDays: number;
  artifacts: ArtifactCaps;
  defaults: PaperSpec;
  papers: ReadonlyMap<string, PaperSpec>;
}

/** 一块白纸的属性：n:<名> 取具名白纸（配置里没有了返回 undefined），r:<哈希> 取默认属性 */
export function specOf(cfg: PaperConfig, paperId: string): PaperSpec | undefined {
  return paperId.startsWith('n:') ? cfg.papers.get(paperId.slice(2)) : cfg.defaults;
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 读一个正数配置：没写取缺省，写坏的告警后取缺省。下限（min）只由 schema 与宿主的配置校验告警把关，
 * 这里不强行抬到下限。
 */
function readPositive(value: unknown, fallback: number, key: string, logger: Logger): number {
  if (isUnset(value)) return fallback;
  const n = positive(value);
  if (n !== undefined) return n;
  logger.warn(`${key} 的值无效，改用 ${fallback}`);
  return fallback;
}

const DEFAULT_SPEC: PaperSpec = {
  remoteAgentType: '',
  remoteAgentEgress: DEFAULT_EGRESS,
  maxWaiting: DEFAULT_MAX_WAITING,
  ...SPEC_NUMBER_DEFAULTS,
};

/** 读一组白纸属性；没写的字段取 fallback，写坏的字段告警后按没写处理 */
function readSpec(raw: Record<string, unknown>, fallback: PaperSpec, where: string, logger: Logger): PaperSpec {
  const spec: PaperSpec = { ...fallback };
  const bad = (key: string) => logger.warn(`${where}.${key} 的值无效，按没写处理`);
  if (!isUnset(raw.remoteAgentType)) {
    if (typeof raw.remoteAgentType === 'string') spec.remoteAgentType = raw.remoteAgentType.trim();
    else bad('remoteAgentType');
  }
  if (!isUnset(raw.remoteAgentEgress)) {
    const egress = EGRESS_CEILINGS.find(e => e === raw.remoteAgentEgress);
    if (egress) spec.remoteAgentEgress = egress;
    else bad('remoteAgentEgress');
  }
  for (const key of ['maxWaiting', 'maxPerUser'] as const) {
    if (isUnset(raw[key])) continue;
    const n = positiveInt(raw[key]);
    if (n === undefined) bad(key);
    else spec[key] = n;
  }
  for (const key of Object.keys(SPEC_NUMBER_DEFAULTS) as Array<keyof typeof SPEC_NUMBER_DEFAULTS>) {
    if (isUnset(raw[key])) continue;
    const n = positive(raw[key]);
    if (n === undefined) bad(key);
    else spec[key] = n;
  }
  return spec;
}

function readArtifactCaps(raw: Record<string, unknown>, logger: Logger): ArtifactCaps {
  const mb = (key: 'maxFileMB' | 'maxRunMB' | 'maxBundleMB' | 'maxPaperMB') =>
    Math.floor(readPositive(raw[key], ARTIFACT_DEFAULTS[key], `artifacts.${key}`, logger) * MB);
  return {
    maxFileBytes: mb('maxFileMB'),
    maxRunBytes: mb('maxRunMB'),
    maxRunFiles: Math.floor(
      readPositive(raw.maxRunFiles, ARTIFACT_DEFAULTS.maxRunFiles, 'artifacts.maxRunFiles', logger),
    ),
    maxBundleBytes: mb('maxBundleMB'),
    maxPaperBytes: mb('maxPaperMB'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTimeZone(value: unknown, logger: Logger): string | undefined {
  if (isUnset(value)) return undefined;
  if (typeof value === 'string') {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: value.trim() });
      return value.trim();
    } catch {
      // 落到下面的告警
    }
  }
  logger.warn(`budgetTimeZone「${String(value)}」不是有效的时区名，按宿主进程的本地时区换日`);
  return undefined;
}

export function readConfig(raw: Readonly<Record<string, unknown>>, logger: Logger): PaperConfig {
  const global = raw.globalDailyCents;
  let globalDailyCents = 0;
  if (typeof global === 'number' && Number.isFinite(global) && global >= 0) globalDailyCents = global;
  else if (!isUnset(global)) logger.warn('globalDailyCents 的值无效，按 0 处理（远端任务不开）');

  const reserve = raw.reserveDefaultCents;
  let reserveDefaultCents = DEFAULT_RESERVE_CENTS;
  if (typeof reserve === 'number' && Number.isFinite(reserve) && reserve >= 1) reserveDefaultCents = Math.ceil(reserve);
  else if (!isUnset(reserve)) logger.warn(`reserveDefaultCents 的值无效，改用 ${DEFAULT_RESERVE_CENTS}`);

  const defaults = readSpec(isRecord(raw.defaults) ? raw.defaults : {}, DEFAULT_SPEC, 'defaults', logger);

  const papers = new Map<string, PaperSpec>();
  const pattern = new RegExp(PAPER_NAME_PATTERN);
  for (const [i, item] of (Array.isArray(raw.papers) ? raw.papers : []).entries()) {
    if (!isRecord(item) || typeof item.name !== 'string' || !pattern.test(item.name)) {
      logger.warn(`papers[${i}] 的 name 不合规（${PAPER_NAME_PATTERN}），这一项不生效`);
      continue;
    }
    const name = item.name;
    if (papers.has(name)) {
      logger.warn(`papers[${i}] 与前面的白纸重名（${name}），这一项不生效`);
      continue;
    }
    papers.set(name, { ...readSpec(item, defaults, `papers[${i}]`, logger), name });
  }

  return {
    globalDailyCents,
    reserveDefaultCents,
    budgetTimeZone: validTimeZone(raw.budgetTimeZone, logger),
    maxRunMinutes: readPositive(raw.maxRunMinutes, NUMBER_DEFAULTS.maxRunMinutes, 'maxRunMinutes', logger),
    sendHtml: raw.sendHtml !== false,
    sendHtmlMaxBytes: Math.floor(
      readPositive(raw.sendHtmlMaxMB, NUMBER_DEFAULTS.sendHtmlMaxMB, 'sendHtmlMaxMB', logger) * MB,
    ),
    pendingHintHours: readPositive(raw.pendingHintHours, NUMBER_DEFAULTS.pendingHintHours, 'pendingHintHours', logger),
    reconcileMinutes: readPositive(raw.reconcileMinutes, NUMBER_DEFAULTS.reconcileMinutes, 'reconcileMinutes', logger),
    taskRetentionDays: readPositive(
      raw.taskRetentionDays,
      NUMBER_DEFAULTS.taskRetentionDays,
      'taskRetentionDays',
      logger,
    ),
    artifacts: readArtifactCaps(isRecord(raw.artifacts) ? raw.artifacts : {}, logger),
    defaults,
    papers,
  };
}

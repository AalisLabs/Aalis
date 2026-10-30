// ============================================================
// 配置：全局上限、换日时区、白纸的默认属性与具名白纸
//
// 配置表单只能表达字段、分组与「数组项全是基础字段」的对象数组，所以白纸的属性拍平成 papers[] 项的
// 同名字段；具名白纸除日额度外，没写的字段取 defaults 分组。房间级的开关与上限（paperEnabled 等六项）是按会话覆盖的
// 字段：只对房间适用，只能设到场所为止（按窗口设，换会话不丢），本插件经会话设置的读取器按房间读。
// ============================================================

import type { ArtifactLimits, EgressCeiling, EgressMode } from '@aalis/api-remote-agent';
import type {} from '@aalis/api-session-settings'; // 按会话字段的声明成员经 declaration merging 并入 SessionFieldSpec
import type { Logger } from '@aalis/core';
import { type ConfigOf, configError, defineConfig } from '@aalis/schema-config';
import { type TextRef, toSource } from '@aalis/schema-i18n';
import { t } from './texts.js';
import { named } from './util.js';

const PAPER_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,31}$';
const PUBLISH_TARGET_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EGRESS_CEILINGS: readonly EgressCeiling[] = ['none', 'allowlist', 'open'];

/** 出网方式与上限的名字：配置的选项、白纸页的「出网」与诊断项共用 */
const EGRESS_NAMES: Record<EgressMode, TextRef> = {
  none: t('egressNone'),
  allowlist: t('egressAllowlist'),
  open: t('egressOpen'),
  unknown: t('egressUnknown'),
};

/** 出网方式的名字：提供者报来的值不在表里时照原样显示 */
export const egressName = (mode: string): string | TextRef => named(EGRESS_NAMES, mode);

const EGRESS_OPTIONS = EGRESS_CEILINGS.map(value => ({ label: EGRESS_NAMES[value], value }));

const DEFAULT_EGRESS: EgressCeiling = 'allowlist';
const DEFAULT_MAX_WAITING = 5;
const DEFAULT_RESERVE_CENTS = 50;
const MB = 1024 * 1024;

/** 数值型配置的缺省值：全局的与白纸属性的 */
const NUMBER_DEFAULTS = {
  maxRunMinutes: 20,
  sendHtmlMaxMB: 5,
  sendMediaMaxMB: 10,
  pendingHintHours: 24,
  reconcileMinutes: 60,
  taskRetentionDays: 30,
} as const;
const SPEC_NUMBER_DEFAULTS = {
  clearAfterDays: 30,
  rotateAfterCents: 300,
  idleArchiveMinutes: 30,
} as const;
const ARTIFACT_DEFAULTS = { maxFileMB: 25, maxRunMB: 50, maxRunFiles: 200, maxBundleMB: 50, maxPaperMB: 2048 } as const;

/** 房间的一项：只对房间适用，只能设到场所为止（按窗口设，换会话不丢），收在高级里 */
const ROOM_FIELD = { appliesTo: ['room'], narrowest: 'place', prominence: 'advanced' } as const;

export const configSchema = defineConfig({
  globalDailyCents: {
    type: 'number',
    label: t('globalCentsLabel'),
    min: 0,
    integer: true,
    onInvalid: 'error',
    description: t('globalCentsDescription'),
  },
  reserveDefaultCents: {
    type: 'number',
    label: t('reserveLabel'),
    default: DEFAULT_RESERVE_CENTS,
    min: 1,
    description: t('reserveDescription'),
  },
  budgetTimeZone: {
    type: 'string',
    label: t('timeZoneLabel'),
    description: t('timeZoneDescription'),
  },
  maxRunMinutes: {
    type: 'number',
    label: t('maxRunLabel'),
    default: NUMBER_DEFAULTS.maxRunMinutes,
    min: 1,
    description: t('maxRunDescription'),
  },
  sendHtml: {
    type: 'boolean',
    label: t('sendHtmlLabel'),
    default: true,
    onInvalid: 'error',
    description: t('sendHtmlDescription'),
  },
  sendHtmlMaxMB: {
    type: 'number',
    label: t('sendHtmlMaxLabel'),
    default: NUMBER_DEFAULTS.sendHtmlMaxMB,
    min: 1,
  },
  sendMediaMaxMB: {
    type: 'number',
    label: t('sendMediaMaxLabel'),
    default: NUMBER_DEFAULTS.sendMediaMaxMB,
    min: 1,
    description: t('sendMediaMaxDescription'),
  },
  paperEnabled: {
    type: 'boolean',
    label: t('paperEnabledLabel'),
    description: t('paperEnabledDescription'),
    default: false,
    session: { ...ROOM_FIELD, order: 0 },
  },
  paperName: {
    type: 'string',
    label: t('paperNameLabel'),
    description: t('paperNameDescription'),
    default: '',
    session: { ...ROOM_FIELD, order: 1 },
  },
  remoteAgentTypes: {
    type: 'multiselect',
    label: t('remoteTypesLabel'),
    description: t('remoteTypesDescription'),
    allowCustom: true,
    default: [],
    session: { ...ROOM_FIELD, order: 2 },
  },
  // 两个金额：没设不另加限制；写坏了原样交来，预算按 0 处理
  remoteAgentUserDailyCents: {
    type: 'number',
    label: t('userCentsLabel'),
    description: t('userCentsDescription'),
    min: 0,
    onInvalid: 'error',
    session: { ...ROOM_FIELD, order: 3, unset: t('noExtraLimit') },
  },
  remoteAgentUserDailyTasks: {
    type: 'number',
    label: t('userTasksLabel'),
    description: t('userTasksDescription'),
    min: 0,
    session: { ...ROOM_FIELD, order: 4, unset: t('userTasksUnset') },
  },
  remoteAgentRoomDailyCents: {
    type: 'number',
    label: t('roomCentsLabel'),
    description: t('roomCentsDescription'),
    min: 0,
    onInvalid: 'error',
    session: { ...ROOM_FIELD, order: 5, unset: t('noExtraLimit') },
  },
  pendingHintHours: {
    type: 'number',
    label: t('pendingHintLabel'),
    default: NUMBER_DEFAULTS.pendingHintHours,
    min: 1,
    description: t('pendingHintDescription'),
  },
  reconcileMinutes: {
    type: 'number',
    label: t('reconcileLabel'),
    default: NUMBER_DEFAULTS.reconcileMinutes,
    min: 10,
    description: t('reconcileDescription'),
  },
  taskRetentionDays: {
    type: 'number',
    label: t('retentionLabel'),
    default: NUMBER_DEFAULTS.taskRetentionDays,
    min: 1,
    description: t('retentionDescription'),
  },
  artifacts: {
    label: t('artifactsLabel'),
    description: t('artifactsDescription'),
    fields: {
      maxFileMB: { type: 'number', label: t('maxFileLabel'), default: ARTIFACT_DEFAULTS.maxFileMB, min: 1 },
      maxRunMB: { type: 'number', label: t('maxRunTotalLabel'), default: ARTIFACT_DEFAULTS.maxRunMB, min: 1 },
      maxRunFiles: {
        type: 'number',
        label: t('maxRunFilesLabel'),
        default: ARTIFACT_DEFAULTS.maxRunFiles,
        min: 1,
        integer: true,
      },
      maxBundleMB: { type: 'number', label: t('maxBundleLabel'), default: ARTIFACT_DEFAULTS.maxBundleMB, min: 1 },
      maxPaperMB: {
        type: 'number',
        label: t('maxPaperLabel'),
        default: ARTIFACT_DEFAULTS.maxPaperMB,
        min: 1,
        description: t('maxPaperDescription'),
      },
    },
  },
  defaults: {
    label: t('defaultsLabel'),
    description: t('defaultsDescription'),
    fields: {
      dailyCents: {
        type: 'number',
        label: t('defaultCentsLabel'),
        min: 0,
        integer: true,
        onInvalid: 'error',
        description: t('defaultCentsDescription'),
      },
      remoteAgentType: {
        type: 'string',
        label: t('remoteTypeLabel'),
        default: '',
        description: t('remoteTypeDescription'),
      },
      remoteAgentEgress: {
        type: 'select',
        label: t('egressLabel'),
        default: DEFAULT_EGRESS,
        options: EGRESS_OPTIONS,
        onInvalid: 'error',
        description: t('egressDescription'),
      },
      maxWaiting: {
        type: 'number',
        label: t('maxWaitingLabel'),
        default: DEFAULT_MAX_WAITING,
        min: 1,
        integer: true,
        description: t('maxWaitingDescription'),
      },
      maxPerUser: {
        type: 'number',
        label: t('maxPerUserLabel'),
        min: 1,
        integer: true,
        description: t('maxPerUserDescription'),
      },
      clearAfterDays: {
        type: 'number',
        label: t('clearAfterLabel'),
        default: SPEC_NUMBER_DEFAULTS.clearAfterDays,
        min: 1,
        description: t('clearAfterDescription'),
      },
      rotateAfterCents: {
        type: 'number',
        label: t('rotateAfterLabel'),
        default: SPEC_NUMBER_DEFAULTS.rotateAfterCents,
        min: 1,
        description: t('rotateAfterDescription'),
      },
      idleArchiveMinutes: {
        type: 'number',
        label: t('idleArchiveLabel'),
        default: SPEC_NUMBER_DEFAULTS.idleArchiveMinutes,
        min: 1,
        description: t('idleArchiveDescription'),
      },
      publishTargets: {
        type: 'string',
        label: t('publishTargetsLabel'),
        default: 'works',
        onInvalid: 'error',
        description: t('publishTargetsDescription'),
      },
      defaultPublishTarget: {
        type: 'string',
        label: t('defaultTargetLabel'),
        default: '',
        description: t('defaultTargetDescription'),
      },
    },
  },
  papers: {
    type: 'array',
    label: t('papersLabel'),
    default: [],
    description: t('papersDescription'),
    items: {
      name: {
        type: 'string',
        label: t('nameLabel'),
        required: true,
        pattern: PAPER_NAME_PATTERN,
        description: t('nameDescription'),
      },
      dailyCents: {
        type: 'number',
        label: t('paperCentsLabel'),
        min: 0,
        integer: true,
        onInvalid: 'error',
        description: t('paperCentsDescription'),
      },
      remoteAgentType: { type: 'string', label: t('remoteTypeLabel'), description: t('useDefaults') },
      remoteAgentEgress: {
        type: 'select',
        label: t('egressLabel'),
        options: [{ label: t('egressDefault'), value: '' }, ...EGRESS_OPTIONS],
        onInvalid: 'error',
      },
      maxWaiting: {
        type: 'number',
        label: t('maxWaitingLabel'),
        min: 1,
        integer: true,
        description: t('useDefaults'),
      },
      maxPerUser: {
        type: 'number',
        label: t('maxPerUserLabel'),
        min: 1,
        integer: true,
        description: t('useDefaults'),
      },
      clearAfterDays: { type: 'number', label: t('clearAfterLabel'), min: 1, description: t('useDefaults') },
      rotateAfterCents: { type: 'number', label: t('rotateAfterLabel'), min: 1, description: t('useDefaults') },
      idleArchiveMinutes: { type: 'number', label: t('idleArchiveLabel'), min: 1, description: t('useDefaults') },
      publishTargets: {
        type: 'string',
        label: t('publishTargetsLabel'),
        onInvalid: 'error',
        description: t('paperTargetsDescription'),
      },
      defaultPublishTarget: {
        type: 'string',
        label: t('defaultTargetLabel'),
        description: t('paperDefaultTargetDescription'),
      },
    },
  },
});

type ParsedPaperConfig = ConfigOf<typeof configSchema>;

/**
 * 只为认出写错的具名白纸：同一份配置再按这份 schema 解析一次，保留每条的名字与两个放开能力的字段的原样字符串
 * （不按选项、模式丢弃），别的字段不读。正式解析会把写坏这两个字段、或别的字段不合规则的条目整条丢掉，
 * 只看正式结果分不出「没写」和「写错」；两份按名字对条数就知道哪个名字有条目被丢了。
 */
export const paperAuditSchema = defineConfig({
  papers: {
    type: 'array',
    label: t('papersLabel'),
    default: [],
    items: {
      name: { type: 'string', label: t('nameLabel') },
      remoteAgentEgress: { type: 'string', label: t('egressLabel') },
      publishTargets: { type: 'string', label: t('publishTargetsLabel') },
    },
  },
});

type PaperAudit = ConfigOf<typeof paperAuditSchema>['papers'];

/** 一块白纸的属性 */
export interface PaperSpec {
  /** 具名白纸的名字；房间白纸没有 */
  name?: string;
  /** 这块白纸每天的额度（美分）；缺省不额外限制，0 禁止开任务。 */
  dailyCents?: number;
  /** 远端代理插件实例 id；空即不开远端任务 */
  remoteAgentType: string;
  remoteAgentEgress: EgressCeiling;
  maxWaiting: number;
  /** 缺省即不按人限制 */
  maxPerUser?: number;
  clearAfterDays: number;
  rotateAfterCents: number;
  idleArchiveMinutes: number;
  /** 这块白纸允许发布到的展示面 ID；空数组禁止发布。 */
  publishTargets: readonly string[];
  /** 可选默认目标，必须属于 publishTargets。 */
  defaultPublishTarget?: string;
}

/** 取回成品的上限：交给提供者的那几项，加上只由写入口把关的白纸目录总占用 */
export interface ArtifactCaps extends ArtifactLimits {
  maxPaperBytes: number;
}

export interface PaperConfig {
  globalDailyCents?: number;
  reserveDefaultCents: number;
  /** 缺省取宿主进程的本地时区 */
  budgetTimeZone?: string;
  maxRunMinutes: number;
  /** paper_send 能否发单个 HTML */
  sendHtml: boolean;
  sendHtmlMaxBytes: number;
  /** paper_send 发图片与视频的大小上限 */
  sendMediaMaxBytes: number;
  pendingHintHours: number;
  reconcileMinutes: number;
  taskRetentionDays: number;
  artifacts: ArtifactCaps;
  defaults: PaperSpec;
  papers: ReadonlyMap<string, PaperSpec>;
  /** 写错而停用的具名白纸：名字 → 原因（进房间的拒绝语时交给模型，取原文）。用它的房间没有白纸，直到改对；同名的后续条目不能顶替 */
  brokenPapers: ReadonlyMap<string, TextRef>;
}

/** 一块白纸的属性：n:<名> 取具名白纸（配置里没有了返回 undefined），场所的白纸取默认属性 */
export function specOf(cfg: PaperConfig, paperId: string): PaperSpec | undefined {
  return paperId.startsWith('n:') ? cfg.papers.get(paperId.slice(2)) : cfg.defaults;
}

const DEFAULT_SPEC: PaperSpec = {
  remoteAgentType: '',
  remoteAgentEgress: DEFAULT_EGRESS,
  maxWaiting: DEFAULT_MAX_WAITING,
  ...SPEC_NUMBER_DEFAULTS,
  publishTargets: ['works'],
};

type SpecFields = ParsedPaperConfig['defaults'] | ParsedPaperConfig['papers'][number];

/** 发布目标写法的问题：含无效的目标 ID 时给出原因 */
function publishTargetsProblem(value: string | undefined): TextRef | undefined {
  if (value === undefined) return undefined;
  const names = value
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  return names.some(name => !PUBLISH_TARGET_PATTERN.test(name)) ? t('invalidTargetId') : undefined;
}

/**
 * 写错而停用的具名白纸：名字第一条的出网上限或发布目标写错；或者这个名字有条目被正式解析整条丢掉（写坏了类型、
 * 别的字段不合规则）。丢掉的那条是不是第一条分不出来，所以同名写了多条、其中有被丢的，也整块停用：
 * 同名的后续条目不能顶替写错的那条。
 */
function brokenPaperNames(audit: PaperAudit, parsed: ParsedPaperConfig['papers']): Map<string, TextRef> {
  const listed = new Map<string, { count: number; first: PaperAudit[number] }>();
  for (const item of audit) {
    const name = item.name?.trim();
    if (!name) continue;
    const entry = listed.get(name);
    if (entry) entry.count++;
    else listed.set(name, { count: 1, first: item });
  }
  const kept = new Map<string, number>();
  for (const item of parsed) kept.set(item.name, (kept.get(item.name) ?? 0) + 1);
  const broken = new Map<string, TextRef>();
  for (const [name, { count, first }] of listed) {
    // 出网上限写错的条目已被正式 schema（onInvalid: 'error'）整条丢掉，按条数对同样会停用；单独认出只为给出具体原因
    const egress = first.remoteAgentEgress;
    const problem =
      egress && !EGRESS_CEILINGS.includes(egress as EgressCeiling)
        ? t('egressNotOption')
        : (publishTargetsProblem(first.publishTargets) ??
          ((kept.get(name) ?? 0) < count ? (count > 1 ? t('duplicateBroken') : t('entryBroken')) : undefined));
    if (problem) broken.set(name, problem);
  }
  return broken;
}

/** 具名白纸日额度独立填写，其他字段继承默认属性；发布目标的显式空值表示禁发布。 */
function readSpec(raw: SpecFields, fallback: PaperSpec, logger: Logger, where: string): PaperSpec {
  const spec: PaperSpec = { ...fallback, dailyCents: raw.dailyCents };
  if (raw.remoteAgentType !== undefined && raw.remoteAgentType !== '')
    spec.remoteAgentType = raw.remoteAgentType.trim();
  const egress = EGRESS_CEILINGS.find(value => value === raw.remoteAgentEgress);
  if (egress) spec.remoteAgentEgress = egress;
  for (const key of ['maxWaiting', 'maxPerUser', 'clearAfterDays', 'rotateAfterCents', 'idleArchiveMinutes'] as const) {
    const value = raw[key];
    if (value !== undefined) spec[key] = value;
  }
  if (raw.publishTargets !== undefined) {
    const names = raw.publishTargets
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);
    // 无效 ID 已在调用方拦下（默认属性层拒绝启用、具名白纸停用），这里只去重
    spec.publishTargets = [...new Set(names)];
  }
  if (raw.defaultPublishTarget !== undefined) {
    spec.defaultPublishTarget = raw.defaultPublishTarget.trim() || undefined;
  }
  if (spec.defaultPublishTarget && !spec.publishTargets.includes(spec.defaultPublishTarget)) {
    logger.warn(`${where}.defaultPublishTarget 不在允许发布目标名单，已取消默认目标`);
    spec.defaultPublishTarget = undefined;
  }
  return spec;
}

function readArtifactCaps(raw: ParsedPaperConfig['artifacts']): ArtifactCaps {
  const mb = (key: 'maxFileMB' | 'maxRunMB' | 'maxBundleMB' | 'maxPaperMB') => Math.floor(raw[key] * MB);
  return {
    maxFileBytes: mb('maxFileMB'),
    maxRunBytes: mb('maxRunMB'),
    maxRunFiles: raw.maxRunFiles,
    maxBundleBytes: mb('maxBundleMB'),
    maxPaperBytes: mb('maxPaperMB'),
  };
}

function validTimeZone(value: string | undefined, logger: Logger): string | undefined {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value.trim() });
    return value.trim();
  } catch {
    // 落到下面的告警
  }
  logger.warn(`budgetTimeZone「${String(value)}」不是有效的时区名，按宿主进程的本地时区换日`);
  return undefined;
}

/** audit 是同一份配置按 {@link paperAuditSchema} 解析出的 papers，用来认出写错而停用的具名白纸 */
export function readConfig(raw: ParsedPaperConfig, logger: Logger, audit: PaperAudit): PaperConfig {
  const defaultsProblem = publishTargetsProblem(raw.defaults.publishTargets);
  if (defaultsProblem) throw configError(t('defaultsTargetsInvalid', { problem: defaultsProblem }));
  const defaults = readSpec(raw.defaults, DEFAULT_SPEC, logger, 'defaults');

  const brokenPapers = brokenPaperNames(audit, raw.papers);
  for (const [name, problem] of brokenPapers)
    logger.warn(
      `具名白纸 ${name}：${toSource(problem)}，这块白纸停用，用它的房间没有白纸，改对之前同名的后续条目也不生效`,
    );

  const papers = new Map<string, PaperSpec>();
  for (const [i, item] of raw.papers.entries()) {
    const name = item.name;
    if (brokenPapers.has(name)) continue;
    if (papers.has(name)) {
      logger.warn(`papers[${i}] 与前面的白纸重名（${name}），这一项不生效`);
      continue;
    }
    papers.set(name, { ...readSpec(item, defaults, logger, `papers[${i}]`), name });
  }

  return {
    globalDailyCents: raw.globalDailyCents,
    reserveDefaultCents: Math.ceil(raw.reserveDefaultCents),
    budgetTimeZone: validTimeZone(raw.budgetTimeZone, logger),
    maxRunMinutes: raw.maxRunMinutes,
    sendHtml: raw.sendHtml,
    sendHtmlMaxBytes: Math.floor(raw.sendHtmlMaxMB * MB),
    sendMediaMaxBytes: Math.floor(raw.sendMediaMaxMB * MB),
    pendingHintHours: raw.pendingHintHours,
    reconcileMinutes: raw.reconcileMinutes,
    taskRetentionDays: raw.taskRetentionDays,
    artifacts: readArtifactCaps(raw.artifacts),
    defaults,
    papers,
    brokenPapers,
  };
}

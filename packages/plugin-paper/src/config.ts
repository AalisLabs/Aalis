// ============================================================
// 配置：全局上限、换日时区、白纸的默认属性与具名白纸
//
// 配置表单只能表达字段、分组与「数组项全是基础字段」的对象数组，所以白纸的属性拍平成 papers[] 项的
// 同名字段；具名白纸除日额度外，没写的字段取 defaults 分组。房间级的开关与上限在会话配置里（paperEnabled 等），
// 不在这里。
// ============================================================

import type { ArtifactLimits, EgressCeiling } from '@aalis/api-remote-agent';
import type { Logger } from '@aalis/core';
import { type ConfigOf, defineConfig } from '@aalis/schema-config';

const PAPER_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,31}$';
const PUBLISH_TARGET_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
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

export const configSchema = defineConfig({
  globalDailyCents: {
    type: 'number',
    label: '全局每天金额上限（美分）',
    min: 0,
    integer: true,
    onInvalid: 'error',
    description:
      '所有白纸合计每天能花多少；留空不限制，0 禁止开新任务。房间自己的上限在会话配置 remoteAgentRoomDailyCents',
  },
  reserveDefaultCents: {
    type: 'number',
    label: '默认预留额（美分）',
    default: DEFAULT_RESERVE_CENTS,
    min: 1,
    description: '受理一件任务时先按这块白纸最近 5 件已记账任务的平均费用预留额度，没有历史时用这个值',
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
  sendMediaMaxMB: {
    type: 'number',
    label: '图片与视频的发送上限（MB）',
    default: NUMBER_DEFAULTS.sendMediaMaxMB,
    min: 1,
    description:
      'paper_send 发图片与视频的大小上限。onebot 出站只把不超过 10 MiB 的媒体内联发出，更大的改交宿主路径，' +
      'NapCat 在容器里时读不到、发不出',
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
    description: '不写名字的房间白纸用这组；具名白纸除日额度外，没写的字段也取这组',
    fields: {
      dailyCents: {
        type: 'number',
        label: '每块白纸每天金额上限（美分）',
        min: 0,
        integer: true,
        onInvalid: 'error',
        description: '共用这块白纸的所有房间合计；留空不额外限制，0 禁止开任务，始终受全局与房间额度限制',
      },
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
      idleArchiveMinutes: {
        type: 'number',
        label: '闲置归档（分钟）',
        default: SPEC_NUMBER_DEFAULTS.idleArchiveMinutes,
        min: 1,
        description: '代理最后一轮结束后这么久没有新任务就归档（在定期检查时执行）',
      },
      publishTargets: {
        type: 'string',
        label: '允许发布到的目标',
        default: 'works',
        description: '逗号分隔的目标 ID（不是网址）；默认 works。留空则这块白纸禁止发布',
      },
      defaultPublishTarget: {
        type: 'string',
        label: '默认发布目标',
        default: '',
        description: '留空时单个获准目标自动选用；多个目标须每次明确选择。填写时必须属于允许名单',
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
      dailyCents: {
        type: 'number',
        label: '这块白纸每天金额上限（美分）',
        min: 0,
        integer: true,
        onInvalid: 'error',
        description: '留空不设单纸上限，不继承默认日额度；共用此白纸的房间合计，0 禁止开任务，仍受全局与房间额度限制',
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
      idleArchiveMinutes: { type: 'number', label: '闲置归档（分钟）', min: 1, description: '留空取默认属性' },
      publishTargets: {
        type: 'string',
        label: '允许发布到的目标',
        description: '逗号分隔的目标 ID；未填写取默认属性，显式留空禁止这块白纸发布',
      },
      defaultPublishTarget: {
        type: 'string',
        label: '默认发布目标',
        description: '未填写取默认属性；显式留空取消默认目标',
      },
    },
  },
});

type ParsedPaperConfig = ConfigOf<typeof configSchema>;

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
}

/** 一块白纸的属性：n:<名> 取具名白纸（配置里没有了返回 undefined），r:<哈希> 取默认属性 */
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
    const valid: string[] = [];
    for (const name of names) {
      if (!PUBLISH_TARGET_PATTERN.test(name)) {
        logger.warn(`${where}.publishTargets 含无效目标 ID，已忽略`);
        continue;
      }
      if (!valid.includes(name)) valid.push(name);
    }
    spec.publishTargets = valid;
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

export function readConfig(raw: ParsedPaperConfig, logger: Logger): PaperConfig {
  const defaults = readSpec(raw.defaults, DEFAULT_SPEC, logger, 'defaults');

  const papers = new Map<string, PaperSpec>();
  for (const [i, item] of raw.papers.entries()) {
    const name = item.name;
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
  };
}

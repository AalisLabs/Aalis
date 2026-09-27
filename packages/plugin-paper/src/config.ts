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
}

export interface PaperConfig {
  globalDailyCents: number;
  reserveDefaultCents: number;
  /** 缺省取宿主进程的本地时区 */
  budgetTimeZone?: string;
  defaults: PaperSpec;
  papers: ReadonlyMap<string, PaperSpec>;
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

const DEFAULT_SPEC: PaperSpec = {
  remoteAgentType: '',
  remoteAgentEgress: DEFAULT_EGRESS,
  maxWaiting: DEFAULT_MAX_WAITING,
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
  return spec;
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
    defaults,
    papers,
  };
}

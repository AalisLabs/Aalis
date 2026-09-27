// ============================================================
// 配置：Cloudflare 凭据、Pages 项目、主站网址、期望的 fail_open、站点标题与简介
//
// accountId 与 apiToken 标 secret、必填，只进请求路径与 Authorization 头，不进日志、状态文件、模型上下文与 WebUI
// 页面数据。格式不对（包括被 WebUI 保存成掩码）不在这里拦：客户端对每个调用按鉴权失败报、不发请求，作品站
// 照常激活，由诊断项与作品页报出来。
//
// API 基址、别名的主机后缀与协议不是配置项（写死在客户端里）：模型能改的地址会成为外泄口。
// 防抖、墓碑天数、定时核对间隔这些是常量，不做配置项。
// ============================================================

import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret）
import type { Logger } from '@aalis/core';
import { type ConfigSchema, configError, defaultsFrom, missingConfigError } from '@aalis/schema-config';

/** Pages 项目名：小写字母、数字与连字符，最长 58 个字符 */
const PROJECT_PATTERN = '^[a-z0-9][a-z0-9-]{0,57}$';
/** 作品分支的形状（p- 加随机串）：生产分支不能是这个样子 */
const WORK_BRANCH_PREFIX = /^p-/i;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export const configSchema: ConfigSchema = {
  accountId: {
    type: 'string',
    label: 'Cloudflare 账号 ID',
    required: true,
    secret: true,
    description: '作品站所在的 Cloudflare 账号（32 位十六进制）。建议这个账号里只放作品站一个 Pages 项目',
  },
  apiToken: {
    type: 'string',
    label: 'Cloudflare API token',
    required: true,
    secret: true,
    description:
      '建议新建只给 Pages Write、带过期时间的账号级 token；离过期不到 14 天诊断项提醒。在 WebUI 修好密钥掩码之前，只在配置文件里写这一项',
  },
  projectName: {
    type: 'string',
    label: 'Pages 项目名',
    default: 'aalis',
    pattern: PROJECT_PATTERN,
    description: '已建好的 Direct Upload 项目。不要删掉它：删了名字会被释放，旧链接可能指向别人的内容',
  },
  productionBranch: {
    type: 'string',
    label: '生产分支',
    default: 'main',
    description: '与项目设置一致；主站部署到这个分支。不能以 p- 开头（作品分支用这个前缀）',
  },
  siteOrigin: {
    type: 'string',
    label: '主站网址',
    default: '',
    description:
      '作品链接的前缀，形如 https://example.com，不带路径；留空为 https://<项目名>.pages.dev。链接发出去之后要一直能打开，定下后不要再改',
  },
  failOpen: {
    type: 'boolean',
    label: 'Functions 额度用尽时照常返回作品',
    default: false,
    description:
      '期望的项目设置 fail_open，与线上不符时暂停自动部署。打开时额度用尽后作品子域不再经过中间件，顶层跳转与清单拦截失效；关闭时额度用尽当天作品子域报错，主站不受影响',
  },
  siteTitle: {
    type: 'string',
    label: '站点标题',
    default: '作品集',
  },
  siteIntro: {
    type: 'textarea',
    label: '站点简介',
    default: '',
    description: '显示在作品集首页标题下',
  },
};

interface WorksSiteConfig {
  accountId: string;
  apiToken: string;
  projectName: string;
  productionBranch: string;
  /** 主站的源（https，不带路径） */
  siteOrigin: string;
  /** 主站的全部源：siteOrigin 与 https://<项目名>.pages.dev（pages.dev 关不掉，两处都算主站） */
  mainOrigins: readonly string[];
  failOpen: boolean;
  siteTitle: string;
  siteIntro: string;
}

const DEFAULTS = defaultsFrom(configSchema) as { siteTitle: string; siteIntro: string };

function requiredText(value: unknown, key: string, note: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw missingConfigError(key, note);
  return text;
}

function readOrigin(value: unknown, projectName: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return `https://${projectName}.pages.dev`;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  const bare =
    url &&
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !raw.includes('?') &&
    !raw.includes('#');
  if (!url || !bare)
    throw configError('siteOrigin 须是 https 网址的源，形如 https://example.com，不带路径、端口与查询串');
  return url.origin;
}

function readText(value: unknown, key: string, fallback: string, logger: Pick<Logger, 'warn'>): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value.trim();
  logger.warn(`${key} 不是文字，改用缺省值`);
  return fallback;
}

export function readConfig(raw: Readonly<Record<string, unknown>>, logger: Pick<Logger, 'warn'>): WorksSiteConfig {
  const accountId = requiredText(raw.accountId, 'accountId', 'Cloudflare 控制台里的账号 ID');
  const apiToken = requiredText(raw.apiToken, 'apiToken', '建议只给 Pages Write、带过期时间');

  const projectName = typeof raw.projectName === 'string' ? raw.projectName.trim() : '';
  if (!new RegExp(PROJECT_PATTERN).test(projectName)) {
    throw configError('projectName 不合规：只能是小写字母、数字与连字符，以字母或数字开头，最长 58 个字符');
  }
  const productionBranch = typeof raw.productionBranch === 'string' ? raw.productionBranch.trim() : '';
  if (!BRANCH_PATTERN.test(productionBranch) || WORK_BRANCH_PREFIX.test(productionBranch)) {
    throw configError('productionBranch 不合规：须是分支名，且不能以 p- 开头（作品分支用这个前缀）');
  }

  const siteOrigin = readOrigin(raw.siteOrigin, projectName);
  const pagesDev = `https://${projectName}.pages.dev`;

  let failOpen = false;
  if (typeof raw.failOpen === 'boolean') failOpen = raw.failOpen;
  else if (raw.failOpen !== undefined && raw.failOpen !== null) logger.warn('failOpen 不是开关值，按关闭处理');

  return {
    accountId,
    apiToken,
    projectName,
    productionBranch,
    siteOrigin,
    mainOrigins: siteOrigin === pagesDev ? [siteOrigin] : [siteOrigin, pagesDev],
    failOpen,
    siteTitle: readText(raw.siteTitle, 'siteTitle', DEFAULTS.siteTitle, logger) || DEFAULTS.siteTitle,
    siteIntro: readText(raw.siteIntro, 'siteIntro', DEFAULTS.siteIntro, logger),
  };
}

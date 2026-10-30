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

import type { Logger } from '@aalis/core';
import { type ConfigOf, configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { canonicalBasePath } from './site/paths.js';
import { t } from './texts.js';

/** Pages 项目名：小写字母、数字与连字符，最长 58 个字符 */
const PROJECT_PATTERN = '^[a-z0-9][a-z0-9-]{0,57}$';
/** 作品分支的形状（p- 加随机串）：生产分支不能是这个样子 */
const WORK_BRANCH_PREFIX = /^p-/i;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const TARGET_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const configSchema = defineConfig({
  targetId: {
    type: 'string',
    label: t('targetIdLabel'),
    default: 'works',
    onInvalid: 'error',
    description: t('targetIdDescription'),
  },
  basePath: {
    type: 'string',
    label: t('basePathLabel'),
    default: '/',
    onInvalid: 'error',
    description: t('basePathDescription'),
  },
  accountId: {
    type: 'string',
    label: t('accountIdLabel'),
    required: true,
    secret: true,
    description: t('accountIdDescription'),
  },
  apiToken: {
    type: 'string',
    label: 'Cloudflare API token',
    required: true,
    secret: true,
    description: t('apiTokenDescription'),
  },
  projectName: {
    type: 'string',
    label: t('projectNameLabel'),
    default: 'aalis',
    onInvalid: 'error',
    description: t('projectNameDescription'),
  },
  productionBranch: {
    type: 'string',
    label: t('productionBranchLabel'),
    default: 'main',
    onInvalid: 'error',
    description: t('productionBranchDescription'),
  },
  siteOrigin: {
    type: 'string',
    label: t('siteOriginLabel'),
    onInvalid: 'error',
    default: '',
    description: t('siteOriginDescription'),
  },
  failOpen: {
    type: 'boolean',
    label: t('failOpenLabel'),
    default: false,
    description: t('failOpenDescription'),
  },
  siteTitle: {
    type: 'string',
    label: t('siteTitleLabel'),
    default: '作品集',
  },
  siteIntro: {
    type: 'textarea',
    label: t('siteIntroLabel'),
    default: '',
    description: t('siteIntroDescription'),
  },
});

export interface WorksSiteConfig {
  targetId: string;
  basePath: string;
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

function readBasePath(value: string): string {
  try {
    return canonicalBasePath(value.trim());
  } catch {
    throw configError(t('basePathInvalid'));
  }
}

function readOrigin(value: string, projectName: string): string {
  const raw = value.trim();
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
  if (!url || !bare) throw configError(t('siteOriginInvalid'));
  return url.origin;
}

/** 把 schema 解析结果转成客户端需要的规范配置；不重复解释原始值。 */
export function resolveConfig(parsed: ConfigOf<typeof configSchema>): WorksSiteConfig {
  const targetId = parsed.targetId.trim();
  if (!TARGET_PATTERN.test(targetId)) throw configError(t('targetIdInvalid'));
  const basePath = readBasePath(parsed.basePath);
  const accountId = parsed.accountId.trim();
  const apiToken = parsed.apiToken.trim();
  if (!accountId) throw configError(t('required', { key: 'accountId' }));
  if (!apiToken) throw configError(t('required', { key: 'apiToken' }));
  const projectName = parsed.projectName.trim();
  if (!new RegExp(PROJECT_PATTERN).test(projectName)) {
    throw configError(t('projectNameInvalid'));
  }
  const productionBranch = parsed.productionBranch.trim();
  if (!BRANCH_PATTERN.test(productionBranch) || WORK_BRANCH_PREFIX.test(productionBranch)) {
    throw configError(t('productionBranchInvalid'));
  }

  const siteOrigin = readOrigin(parsed.siteOrigin, projectName);
  const pagesDev = `https://${projectName}.pages.dev`;

  return {
    targetId,
    basePath,
    accountId,
    apiToken,
    projectName,
    productionBranch,
    siteOrigin,
    mainOrigins: siteOrigin === pagesDev ? [siteOrigin] : [siteOrigin, pagesDev],
    failOpen: parsed.failOpen,
    siteTitle: parsed.siteTitle.trim() || configSchema.siteTitle.default,
    siteIntro: parsed.siteIntro.trim(),
  };
}

export function readConfig(raw: Readonly<Record<string, unknown>>, logger: Pick<Logger, 'warn'>): WorksSiteConfig {
  return resolveConfig(parseConfig(configSchema, raw, logger));
}

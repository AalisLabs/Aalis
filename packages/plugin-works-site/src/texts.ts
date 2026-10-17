// 本插件自己的原文字典：作品页撤下的回执，告警与暂停的原因（落盘，键是同一条告警的标识）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  withdrawn: '已撤下',
  withdrawnDegraded: '撤下已登记；站点状态：{state}',
  productionBranch: '生产分支与配置不符',
  failOpenMismatch: '{name} 的 fail_open 与配置不符',
  binding: '{name} 存在 {key} 绑定',
  unknownSetting: '{name} 出现未知设置 {key}',
  domains: '域名列表与配置不符',
  unknownDeployment: '发现账外部署 {id}',
  groupMissing: '撤下作品的组映射缺失',
  nonceAmbiguous: '同一 nonce 对应多个部署',
  aliasInvalid: '部署别名不合格',
  aliasMismatch: '部署别名与分支名不一致',
  cleanupFailed: '旧部署清理失败',
  verifyFailed: '部署后线上核对失败',
  tokenExpired: 'Cloudflare token 已过期',
  authFailed: 'Cloudflare 鉴权失败',
  periodicCheckFailed: '定时核对失败',
  deployFailedRepeatedly: '部署连续失败',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-works-site', language: 'zh-CN', source: SOURCE, locales: { en } });

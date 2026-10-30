// 本插件自己的原文字典：显示名、配置项，三个工具分组的名字与概述（分组的 description 照旧只给模型）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'OneBot 工具',
  groupManagementLabel: '群管理工具',
  groupManagementEnabledLabel: '启用群管理工具',
  groupManagementEnabledDescription: '禁言、踢人、设置群名片、撤回消息等',
  groupInfoLabel: '群信息查询',
  groupInfoEnabledLabel: '启用群信息查询',
  groupInfoEnabledDescription: '查询群/成员信息',
  accountLabel: '账号与好友',
  accountEnabledLabel: '启用账号与好友查询',
  accountEnabledDescription: '群列表、好友列表等',
  interactionLabel: '特殊交互',
  interactionEnabledLabel: '启用特殊交互',
  interactionEnabledDescription: '戳一戳、群打卡等',
  sessionHistoryLabel: '会话历史读取',
  sessionHistoryEnabledLabel: '启用 OneBot 专属历史工具',
  sessionHistoryEnabledDescription:
    '注册 onebot_resolve_session_id / onebot_get_session_history（按群号/QQ 号读取近期历史）。能读哪些会话按会话管理的跨会话规则。',
  maxLimitLabel: '单次最多读取条数上限',
  maxLimitDescription: 'agent 传入的 limit 参数会被截断到该上限。',
  defaultLimitLabel: '默认读取条数（agent 不传 limit 时）',
  defaultLimitDescription: '不能超过 maxLimit。',
  dailyGroup: 'OneBot 只读与日常',
  dailyGroupSummary: '只读查询（群信息/成员/好友列表/历史/登录信息）+ 日常低风险互动（戳一戳、好友赞）',
  groupGroup: 'OneBot 群务',
  groupGroupSummary: '群务管理：禁言/全员禁言/踢人/撤回消息/设置群名片/改群名/设管理员/群打卡/审批加群申请 等',
  personalGroup: 'OneBot 个人/私聊',
  personalGroupSummary: '影响 bot 账号本身的人际关系：退群、删好友、处理好友申请、接受/拒绝入群邀请',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-tool-onebot', language: 'zh-CN', source: SOURCE, locales: { en } });

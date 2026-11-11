// 本插件自己的原文字典：显示名、配置项、/clear 的类型显示名与结果行
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '向量记忆',
  searchLabel: '搜索设置',
  topKLabel: '最大返回数',
  topKDescription: '语义搜索返回的命中条数（每条会再带上下文窗口）',
  timeWeightLabel: '时间权重',
  timeWeightDescription: '0=纯语义，1=纯时间近因',
  userPriorityBoostLabel: '同用户加权系数',
  userPriorityBoostDescription: '「跨会话检索模式」选「同用户增强」时，同一用户消息的命中分数乘以该系数（>1 表示优先）',
  perItemMaxCharsLabel: '单条截断字数',
  perItemMaxCharsDescription:
    '每条消息呈现给模型时的字符上限；0 = 不截断（推荐）。超出会以「…[已截断，还剩 N 个字符未展示]」明示。',
  minScoreLabel: '最低相似度阈值',
  minScoreDescription: '0~1，命中分数（时间加权前的语义分）低于该值则丢弃。0 表示不过滤',
  contextExpandLabel: '上下文情景扩展',
  contextExpandDescription: '命中后取它在原会话里前后相邻的消息，还原当时的情景。',
  windowLabel: '扩展窗口',
  windowDescription: '命中前后各取 N 条消息。0 = 仅命中本身，建议 2~5',
  crossSessionLabel: '跨会话也扩展',
  crossSessionDescription: '命中消息来自其他会话时，是否对那个会话也取上下文',
  indexingLabel: '索引设置',
  indexingDescription: '控制后台向量索引的削峰与并发。搜索路径不受该队列影响。',
  concurrencyLabel: '最大并发索引数',
  concurrencyDescription:
    '同时进行的后台向量化与写入任务数。0 或负数表示不限制；建议 2~10，过高可能压垮本地向量化服务。',
  maxQueueSizeLabel: '最大索引队列长度',
  maxQueueSizeDescription: '待索引消息队列上限。0 或负数表示不限制；超出后丢弃最旧待索引消息，避免内存无限增长。',
  recallRolesLabel: '召回角色范围',
  recallRolesDescription:
    'AI 自己过去的回复是否作为命中参与召回。「只召回对方」只让对方的消息作为命中，命中前后扩展出的消息不过滤；不论哪档，召回的 AI 回复都标明是 AI 自己说的。',
  recallRolesAll: '对方与 AI 自己都召回',
  recallRolesOthers: '只召回对方（过滤 AI 自己的回复）',
  crossSessionModeLabel: '跨会话检索模式',
  crossSessionModeDescription: '控制向量记忆的跨会话可见范围',
  modeIsolated: '不互通（仅当前会话）',
  modeUser: '同用户增强（跨会话，同用户加权）',
  modePlatform: '同平台（仅相同平台的会话）',
  modeAll: '全部打通（所有平台所有会话）',
  clearedAll: '所有向量记忆已清空',
  clearedSession: '向量记忆已清空（{count, number} 条）',
  clearUnsupported: '当前向量存储不支持会话级清空，向量记忆未清除（可改用 /clear.all 或换支持按条件删除的后端）',
  clearFailed: '向量清空失败：{error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-memory-vector', language: 'zh-CN', source: SOURCE, locales: { en } });

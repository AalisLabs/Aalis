// 本插件自己的原文字典：发到会话里的「[系统]」「[错误]」与 LLM 解析失败的说明，用量拆分表的分项名，按会话字段的称呼与说明
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  systemNotice: '[系统] {why}',
  turnError: '[错误] {error}',
  llmNoneErrored:
    '未找到任何具备 chat 能力的 LLM —— 以下 LLM 插件激活失败：{plugins, list}。可用 /doctor 查看原因（需要相应权限）。',
  llmNone:
    '未找到任何具备 chat 能力的 LLM —— 请确认已安装并启用至少一个 LLM 提供者插件（如 @aalis/plugin-llm-deepseek）。',
  llmNotFound: '配置指向的模型不存在：{wanted}。当前可用：{models, list}{more}。',
  llmMore: '等 {count, number} 个（用 /model 查看全部）',
  llmUnresolved:
    'LLM 解析失败：能力过滤后有 {count, number} 个可用 entry，但解析时一个都没取到（服务可能正在装卸中，稍后重试）。',
  partHistory: '历史消息',
  partToolResults: '工具结果',
  partToolDefs: '工具定义',
  partPersona: '人设',
  partMemorySummary: '对话摘要',
  partMemoryVector: '向量记忆',
  partSkills: '技能',
  partPlatform: '平台提示',
  partSubtask: '子任务',
  partSystemOther: '其余系统提示',
  llmLabel: '模型',
  llmDescription:
    '这个会话用的对话模型。没设时跟随服务偏好：给本插件设了 llm 的服务偏好时用它，否则用全局偏好，都没有时用第一个可用的对话模型',
  llmUnset: '跟随服务偏好',
  thinkLabel: '深度思考',
  thinkDescription: '可选的档位随所用的模型；没设或当前模型没有这一档时按模型的默认档',
  thinkUnset: '按模型的默认档',
  maxToolIterationsLabel: '最大工具迭代',
  maxToolIterationsDescription: '一轮里工具调用循环的最大次数',
  historyLimitLabel: '历史条数上限',
  historyLimitDescription:
    '发给模型的会话历史不超过这么多条：超过时一次丢掉最早的一半，之后照常累积到这个条数再丢一段；丢掉的只是这一轮发给模型的，会话历史本身保留，压缩时照样进摘要。装了摘要插件时，会话的消息到这个条数就压缩。0 表示不按条数：发全部活跃历史，只按自动压缩线压缩',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-agent', language: 'zh-CN', source: SOURCE, locales: { en } });

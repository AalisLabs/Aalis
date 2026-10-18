// 本插件自己的原文字典：发到会话里的「[系统]」「[错误]」与 LLM 解析失败的说明，/session 的版式和说明句，用量拆分表的分项名，
// 会话设置项「历史条数上限」的说明
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
  noSessionManager:
    '会话管理没有在运行，会话设置要靠它：在 WebUI 插件区启用「会话管理」，或把它从配置文件的 disabledPlugins 里删掉；启用了还起不来就用 /doctor 看原因',
  sessionLine: '会话: {session}',
  fieldModel: '模型',
  fieldPersona: '人设',
  fieldThink: '深度思考',
  inheritedLine: '{field}: {value}  [来源: {from}]',
  overrideLine: '{field}: {value}  [来源: 会话覆盖]',
  overriddenLine: '  被覆盖的继承值: {value}  [来源: {from}]',
  unsetValue: '(默认)',
  fromDefault: '默认',
  fromPlatform: '{layer} {platform}',
  fromType: '{layer} {platform} · {type}',
  fromPlace: '{layer}『{place}』',
  modelInUse: '  这一轮会用: {model}',
  thinkingFixed: '  当前模型不能调',
  thinkingLevels: '  当前模型的档位：{levels, list}，默认 {fallback}',
  thinkingLevelsMissing: '  当前模型的档位：{levels, list}，默认 {fallback}；当前模型没有这一档，按默认',
  thinkingLevel: '{id}（{label}）',
  noSuchLevel: '当前模型没有档位「{level}」，可选：{levels, list, or}',
  noOwnRecord: '（本对话尚无独立配置记录，全部继承默认）',
  setHint: '改配置: /session.set -m <模型> -p <人设> -t <档位> [-n <名>]   （/model 看可用模型/人设名错时也会列出）',
  resetHint: '复位:   /session.reset          （-m 仅模型 / -p 仅人设 / -t 仅深度思考）',
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
  historyLimitDescription:
    '发给模型的会话历史不超过这么多条：超过时一次丢掉最早的一半，之后照常累积到这个条数再丢一段；丢掉的只是这一轮发给模型的，会话历史本身保留，压缩时照样进摘要。装了摘要插件时，会话的消息到这个条数就压缩。0 表示不按条数：发全部活跃历史，只按自动压缩线压缩',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-agent', language: 'zh-CN', source: SOURCE, locales: { en } });

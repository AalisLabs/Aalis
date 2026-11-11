// 本插件自己的原文字典：显示名与配置项，发到会话里的「[系统]」「[错误]」与 LLM 解析失败的说明，用量拆分表的分项名，按会话
// 字段的称呼与说明，/stop 的说明与回复，/model 与 /persona 的说明与分页回复
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '默认 Agent',
  systemPromptLabel: '行为准则提示词',
  systemPromptDescription: '定义 Agent 的行为准则。当人设插件存在时，身份描述由人设提供，此处仅作为行为指令追加。',
  memoryTokenBudgetLabel: '长期记忆预留 Token',
  memoryTokenBudgetDescription:
    '注入的系统消息（技能、摘要、记忆等）合计的 token 额度。只在裁掉历史后仍超预算时起作用：超出时按比例缩减，仍超就删除',
  promptBuildTimeoutMsLabel: '提示词贡献构建超时 (ms)',
  promptBuildTimeoutMsDescription: '组装提示词时等每一块内容的上限，超时的那块本轮不加入，其余照常。0 表示不设限。',
  toolResultMaxRatioLabel: '工具结果最大比例',
  toolResultMaxRatioDescription: '单条工具结果占上下文窗口的最大比例 (0~1)，超出则截断。例如 0.15 表示 15%',
  trimThresholdRatioLabel: '裁剪触发比例',
  trimThresholdRatioDescription:
    '裁剪预算占上下文窗口的比例，再扣去最大输出与安全余量。默认 1.0 用满窗口，调低可提前裁剪。压缩时机在会话设置的「自动压缩线」与「历史条数上限」里调。',
  systemNotice: '[系统] {why}',
  turnError: '[错误] {error}',
  llmNoneErrored:
    '未找到任何具备 chat 能力的模型 —— 以下模型插件激活失败：{plugins, list}。可用 /doctor 查看原因（需要相应权限）。',
  llmNone:
    '未找到任何具备 chat 能力的模型 —— 请确认已安装并启用至少一个模型提供者插件（如 @aalis/plugin-llm-deepseek）。',
  llmNotFound: '配置指向的模型不存在：{wanted}。当前可用：{models, list}{more}。',
  llmMore: ' 等 {count, number} 个（用 /model 查看全部）',
  llmUnresolved:
    '模型解析失败：能力过滤后有 {count, number} 个可用 entry，但解析时一个都没取到（服务可能正在装卸中，稍后重试）。',
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
    '这个会话用的对话模型。没设时跟随服务偏好：先看给本插件设的偏好，再看全局偏好，都没有时用第一个可用的对话模型',
  llmUnset: '跟随服务偏好',
  thinkLabel: '深度思考',
  thinkDescription: '可选的档位随所用的模型；没设或当前模型没有这一档时按模型的默认档',
  thinkUnset: '按模型的默认档',
  maxToolIterationsLabel: '最大工具迭代',
  maxToolIterationsDescription: '一轮里工具调用循环的最大次数；没设即不限，卡在工具调用里的一轮只能手动停下',
  maxToolIterationsUnset: '不限',
  historyLimitLabel: '历史条数上限',
  historyLimitDescription:
    '发给模型的会话历史最多这么多条，超过时丢掉最早的一半（会话历史本身保留）；装了摘要插件时，到这个条数就压缩。0 表示不按条数，只按自动压缩线压缩',
  stopDescription: '停下本会话在跑的一轮；排着的消息照常开下一轮。参与这一轮的人和 owner 能停',
  stopped: '已停下这一轮',
  stopIdle: '没有在跑的一轮',
  stopDenied: '只有参与这一轮的人和 owner 能停',
  modelDescription: '列出/搜索可用对话模型。分页显示，-p 翻页；如 /model grok',
  personaDescription: '列出/搜索可用人设（分页，-p 翻页）',
  pageOptionDescription: '页码（默认 1）',
  modelsLabel: '可用模型',
  personasLabel: '可用人设',
  pagedNoMatch: '无匹配 "{keyword}" 的{label}',
  pagedNone: '（无{label}）',
  pagedHeader: '{label}（共 {count, number} · 第 {page, number}/{pages, number} 页）：',
  pagedHeaderMatching: '{label}（含"{keyword}" 共 {count, number} · 第 {page, number}/{pages, number} 页）：',
  pagedHint: '—— 翻页：{command} -p {next}　搜索：{command} <关键词>',
  pagedHintMatching: '—— 翻页：{command} {keyword} -p {next}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-agent', language: 'zh-CN', source: SOURCE, locales: { en } });

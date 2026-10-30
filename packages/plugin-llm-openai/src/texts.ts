// 本插件自己的原文字典：配置项、思考档位名与给人看的报错（经 agent 进会话、作插件失败原因）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  baseUrlInvalid: 'baseUrl 不是有效的 URL，需写成完整地址，如 https://api.openai.com/v1',
  baseUrlQuery: 'baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
  baseUrlCredentials: 'baseUrl 不能带用户名或密码（user:pass@），密钥请填在 apiKey',
  withCause: '{error} ← {detail}',
  hintAuth: '密钥无效或没有权限',
  hintPayment: '余额不足或需要付费',
  hintNotFound: '模型或地址不对',
  hintRateLimit: '请求过多或额度不足',
  hintUpstream: '上游服务故障',
  apiError: '{provider} API 错误 ({status})',
  apiErrorHint: '{provider} API 错误 ({status})：{hint}',
  upstreamMessage: '上游说明：{message}',
  seeLogs: '详情见日志',
  levelOff: '关',
  levelOn: '开',
  levelMinimal: '最低',
  levelLow: '低',
  levelMedium: '中',
  levelHigh: '高',
  apiKeyDescription: 'OpenAI API 密钥（本地服务可留空）',
  baseUrlLabel: 'API 地址',
  baseUrlDescription:
    'API 端点完整前缀（含版本段，如 https://api.openai.com/v1）；插件只在其后拼 /chat/completions 与 /models。可替换为任何兼容服务（如 Gemini 的 https://generativelanguage.googleapis.com/v1beta/openai）。',
  customModelsLabel: '自定义模型',
  customModelsDescription:
    '手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。',
  discoverModelsLabel: '自动发现模型',
  discoverModelsDescription:
    '启动时请求 /models 发现可用模型，WebUI 可刷新模型列表。网关不提供 /models 时关闭：不发发现请求，只注册 customModels（此时必填），也不支持刷新。',
  modelCapabilitiesLabel: '单模型能力覆盖',
  modelCapabilitiesDescription:
    '按行指定某个模型的能力集。有该模型的表项时**覆盖**插件启发式推断，与 adapter 默认能力仍取并集。\n格式：`<modelId>: <cap1>,<cap2>,...`，每行一条。如：gpt-4o: chat,tool_calling,vision,streaming\n可用能力：chat / tool_calling / vision / streaming / thinking 等。',
  providerCapabilitiesLabel: '适配器默认能力（逗号分隔）',
  providerCapabilitiesDescription:
    '为本适配器下所有模型额外补充的能力。最终某模型的能力 = 此处能力 ∪ 模型级别能力。例：chat,tool_calling,streaming',
  timeoutLabel: '停顿超时（秒）',
  timeoutDescription:
    '多久收不到新的生成内容算超时（秒）。一直在输出不算超时；不流式的请求要在这段时间内收到整份回复。模型思考时不发出思考内容（如 OpenAI 官方的推理模型）或输入很长时，建议适当调大。0 = 不限制。',
  temperatureLabel: '温度',
  temperatureDescription: '0-2，越高越随机',
  maxTokensLabel: '最大 Token',
  maxTokensDescription: '单次回复最大生成 token 数，须为正整数，否则实例转为出错',
  contextLengthLabel: '上下文长度',
  contextLengthDescription: '模型上下文窗口大小',
  thinkingParamLabel: '思考档位的写法',
  thinkingParamEffort: 'reasoning_effort：档位按模型族（OpenAI 官方与多数兼容端点）',
  thinkingParamThinking: 'thinking.type：关、开（DeepSeek 风格的端点或中转）',
  thinkingParamDescription:
    '能思考的模型（内置表里的 o 系列与 gpt-5 系列，gpt-5-chat 除外，或单模型能力覆盖里写了 thinking 的）按这种写法提供深度思考的档位。请求指定了档位才发对应字段，没指定时不发、按端点自己的默认。端点不认所选字段时会拒收指定了档位的请求，这时换一种写法，或在单模型能力覆盖里去掉这个模型的 thinking。',
  requestTimeout: 'LLM 请求超时：{seconds} 秒内没有收到新的生成内容，可在配置里调大 timeout',
  pluginClosed: 'LLM 插件已停用或重载，这次请求没有发出',
  unreachable: 'LLM 连不上服务：检查 baseUrl 与网络，详情见日志',
  notJson: 'LLM 应答不是 JSON ({status})；详情见日志',
  discoveryNotJson: '响应不是 JSON: {excerpt}',
  discoveryNotList: '响应不是模型列表（需要 data 数组，每项带字符串 id）：{excerpt}',
  discoveryFailed: '模型发现失败 {url}: {error}',
  emptyChoices: 'LLM 返回了空的 choices',
  emptyBody: 'LLM API 返回了空的响应体，无法进行流式读取',
  apiKeyRequired: '使用 OpenAI 官方 API 时必填',
  customModelsRequired: '关闭 discoverModels 时必填',
  noModelsDiscoveryFailed:
    '取不到模型列表，没有可注册的模型：检查 apiKey、baseUrl 与网络后重载本插件，或在 customModels 里写明要用的模型。原因：{error}',
  noModels: '已连接 {baseUrl}，但未发现任何可用模型；可在 customModels 里写明要用的模型',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-llm-openai', language: 'zh-CN', source: SOURCE, locales: { en } });

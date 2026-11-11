// 本插件自己的原文字典：配置项、思考档位名与给人看的报错（经 agent 进会话、作插件失败原因）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  baseUrlInvalid: 'baseUrl 不是有效的 URL，需写成完整地址，如 https://api.deepseek.com',
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
  levelHigh: '高',
  levelAuto: '自动',
  levelMax: '最高',
  apiKeyDescription: 'DeepSeek API 密钥',
  baseUrlLabel: 'API 地址',
  baseUrlDescription: 'API 端点完整前缀（官方无版本段）；插件只在其后拼 /chat/completions 与 /models',
  customModelsLabel: '自定义模型',
  customModelsDescription:
    '手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。',
  discoverModelsLabel: '自动发现模型',
  discoverModelsDescription: '启动时向服务查询可用模型。服务不提供模型列表时关闭，这时只用自定义模型，且必须填写。',
  modelCapabilitiesLabel: '单模型能力覆盖',
  modelCapabilitiesDescription:
    '逐个模型指定能力。写了的模型不再按名字推断，能力为这里写的加上适配器默认能力。\n格式：`<modelId>: <cap1>,<cap2>,...`，每行一条。如：deepseek-flash: chat,tool_calling,streaming,thinking,vision\n可用能力：chat / tool_calling / vision / streaming / thinking 等。',
  providerCapabilitiesLabel: '适配器默认能力',
  providerCapabilitiesDescription: '给所有模型额外加上的能力，逗号分隔。例：chat,tool_calling,streaming',
  timeoutLabel: '停顿超时（秒）',
  timeoutDescription:
    '多久收不到新的生成内容算超时，持续输出（含思考）不算；不流式的请求要在这段时间内收到完整回复。0 为不限。',
  temperatureLabel: '温度',
  temperatureDescription: '0-2，越高越随机',
  maxTokensLabel: '最大 Token',
  maxTokensDescription: '单次回复最大生成 token 数，须为正整数，否则实例转为出错',
  contextLengthLabel: '上下文长度',
  contextLengthDescription: '模型上下文窗口大小',
  strictToolCallsLabel: 'Strict 工具调用',
  strictToolCallsDescription: '开启后所有工具定义都用 strict 模式，模型给的参数严格符合 JSON Schema。',
  forceJsonOutputLabel: '强制 JSON 输出',
  forceJsonOutputDescription:
    '开启后不带工具的请求要求模型输出 JSON，配合角色卡的输出格式使用。系统提示里须含 json 字样。',
  thinkingLabel: '默认思考档位',
  thinkingDescription:
    '能思考的模型在请求没指定档位时用这一档，会话设置的「深度思考」优先。自动：开启思考，强度由 DeepSeek 在高与最高之间选。',
  requestTimeout: 'DeepSeek 请求超时：{seconds} 秒内没有收到新的生成内容，可在配置里调大 timeout',
  pluginClosed: 'DeepSeek 插件已停用或重载，这次请求没有发出',
  pluginStopped: 'DeepSeek 插件已停用或重载，这次请求中途停下',
  unreachable: 'DeepSeek 连不上服务：检查 baseUrl 与网络，详情见日志',
  notJson: 'DeepSeek 应答不是 JSON ({status})；详情见日志',
  discoveryNotJson: '响应不是 JSON: {excerpt}',
  discoveryNotList: '响应不是模型列表（需要 data 数组，每项带字符串 id）：{excerpt}',
  discoveryFailed: '模型发现失败 {url}: {error}',
  emptyChoices: 'DeepSeek 返回了空的 choices',
  emptyBody: 'DeepSeek API 返回了空的响应体，无法进行流式读取',
  customModelsRequired: '关闭 discoverModels 时必填',
  noModelsDiscoveryFailed:
    '取不到模型列表，没有可注册的模型：检查 apiKey、baseUrl 与网络后重载本插件，或在 customModels 里写明要用的模型。原因：{error}',
  noModels: '已连接 {baseUrl}，但未发现任何可用模型；可在 customModels 里写明要用的模型',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-llm-deepseek', language: 'zh-CN', source: SOURCE, locales: { en } });

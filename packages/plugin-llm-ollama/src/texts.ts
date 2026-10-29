// 本插件自己的原文字典：配置项、思考档位名与给人看的报错（经 agent 进会话、作插件失败原因）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  baseUrlInvalid: 'baseUrl 不是有效的 URL，需写成完整地址，如 http://localhost:11434',
  baseUrlQuery: 'baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
  baseUrlCredentials: 'baseUrl 不能带用户名或密码（user:pass@），本插件不支持带凭据访问 Ollama',
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
  baseUrlLabel: 'Ollama 地址',
  baseUrlDescription: '本地 Ollama 服务的 HTTP 地址',
  customModelsLabel: '自定义模型',
  customModelsDescription:
    '手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。',
  discoverModelsLabel: '自动发现模型',
  discoverModelsDescription:
    '启动时请求 /api/tags 发现已安装的模型，WebUI 可刷新模型列表。服务不提供 /api/tags 时关闭：不发发现请求，只注册 customModels（此时必填），也不支持刷新。',
  modelCapabilitiesLabel: '单模型能力覆盖',
  modelCapabilitiesDescription:
    '强制覆盖某模型的能力(优先级最高,高于 /api/show 自动探测与家族表),与 adapter 默认能力取并集。\n格式：`<modelId>: <cap1>,<cap2>,...`，每行一条。如：nemotron3:33b: chat,vision,tool_calling',
  providerCapabilitiesLabel: '适配器默认能力（逗号分隔）',
  providerCapabilitiesDescription:
    '兜底默认能力:仅当某模型既无法从 Ollama /api/show 探测、又不在内置家族表时才使用。能力现已自动探测,通常留空即可（填了反而可能给不支持的模型乱标能力）。例：chat,tool_calling,streaming',
  timeoutLabel: '停顿超时 (秒)',
  timeoutDescription:
    '多久收不到新的生成内容算超时（秒）。一直在输出（含思考内容）不算超时；工具调用要等 Ollama 生成完整才一次给出，生成期间不算输出；不流式的请求（含带音频的请求）要在这段时间内收到整份回复。大模型或长上下文出第一段内容慢、工具参数很长时，建议适当调大。0 = 不限制。',
  temperatureLabel: '温度',
  temperatureDescription: '0-2，越高越随机',
  maxTokensLabel: '最大 Token',
  maxTokensDescription: '单次回复最大生成 token 数（num_predict），须为正整数，否则实例转为出错',
  contextLengthLabel: '上下文长度',
  contextLengthDescription: '模型上下文窗口大小（num_ctx）',
  keepAliveLabel: '模型保活时间',
  keepAliveDescription: '模型在显存中保留的时间，如 5m、1h、0（立即卸载）',
  thinkingLabel: '默认思考档位',
  thinkingDescription:
    '报告了思考能力的模型（或单模型能力覆盖里写了 thinking 的）在请求没指定档位时用这一档，会话设置的「深度思考」压过它。没有思考能力的模型不发 think 参数。',
  requestTimeout: 'Ollama 请求超时：{seconds} 秒内没有收到新的生成内容，可在配置里调大 timeout',
  pluginClosed: 'Ollama 插件已停用或重载，这次请求没有发出',
  unreachable: 'Ollama 连不上服务：检查 baseUrl 与网络，详情见日志',
  notJson: 'Ollama 应答不是 JSON ({status})；详情见日志',
  discoveryNotJson: '响应不是 JSON: {excerpt}',
  discoveryNotList: '响应不是模型列表（需要 models 数组，每项带字符串 name）: {excerpt}',
  discoveryFailed: '模型发现失败 {url}: {error}',
  emptyBody: 'Ollama API 返回了空的响应体，无法进行流式读取',
  imagesUnavailable: '图片全部获取失败（共 {count} 张），拒绝降级为纯文本请求',
  audioDataUrlOnly: 'Ollama 兼容接口的音频只收 data:audio/<格式>;base64, 形式（插件不读本地路径与链接）',
  audioFormatUnsupported: 'Ollama 兼容接口不接受 {format} 音频',
  customModelsRequired: '关闭 discoverModels 时必填',
  noModelsDiscoveryFailed:
    '取不到 Ollama 的模型列表，没有可注册的模型：确认 Ollama 在运行、baseUrl 写对后重载本插件，或在 customModels 里写明要用的模型。原因：{error}',
  noModels:
    'Ollama 已连接 {baseUrl}，但未发现任何可用模型；先用 ollama pull 下载模型，或在 customModels 里写明要用的模型',
  noChatModels:
    'Ollama 已连接 {baseUrl}，但没有可用的对话模型：{models} 都没有报告对话能力（如嵌入模型）；先用 ollama pull 下载对话模型',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-llm-ollama', language: 'zh-CN', source: SOURCE, locales: { en } });

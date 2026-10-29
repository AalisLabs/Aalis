// 本插件自己的原文字典：显示名、配置项与配置报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'Cursor 云端代理',
  apiKeyDescription: 'Cursor 后台生成的 API key。只在宿主进程里用，不传给远端代理',
  apiKeyNote: '在 Cursor 后台生成',
  baseUrlLabel: 'API 地址',
  baseUrlDescription: 'Cloud Agents API 的根地址，插件在其后拼 /v1/…',
  modelLabel: '模型',
  modelDescription:
    '建代理用的模型。参数须写全，并等于 /v1/models 列出的某个变体，第一次使用时校验，不成立时提供者不可用；只写模型 id 会按默认变体（fast、500k）计费',
  modelIdLabel: '模型 id',
  modelParamsLabel: '模型参数',
  modelParamsDescription: '参数名到取值；布尔值须加引号写成字符串（如 fast: "false"），写错则不激活，避免改变费用档位',
  egressModeLabel: '出网方式',
  egressNone: '不出网',
  egressAllowlist: '白名单',
  egressOpen: '不限',
  egressUnknown: '未知',
  egressModeDescription:
    'owner 在 Cursor 后台给云端代理设的出网方式。接口读不到它，Aalis 无法核实，白纸页与诊断项标「未核实」；未知按不限计',
  createTimeoutSecondsLabel: '建代理超时（秒）',
  createTimeoutSecondsDescription: '建代理的请求要约 60 秒才回；超时后用同一 agentId 取回，不会重复建',
  requestTimeoutSecondsLabel: '请求超时（秒）',
  requestTimeoutSecondsDescription: '其余请求的超时；实测单次请求有时要 5 秒以上',
  streamIdleSecondsLabel: '事件流空闲超时（秒）',
  streamIdleSecondsDescription:
    '事件流连上后约 30 秒才有第一次心跳，之后每 15 到 30 秒一次；超过这么久没有任何数据就断开重连',
  reconcileIgnoreNamesLabel: 'owner 自管的代理名',
  reconcileIgnoreNamesDescription: '列举账号下的代理时跳过这些名字，核对时不把它们当作未登记的代理',
  baseUrlNotPlain: 'baseUrl 需为不带用户名或密码的完整 URL',
  baseUrlHasQuery: 'baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-remote-agent-cursor',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

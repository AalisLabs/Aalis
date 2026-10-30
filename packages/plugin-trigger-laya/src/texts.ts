// 本插件自己的原文字典：显示名、触发服务的标签、配置项与配置报错，诊断项的说明，判定不可用、侧车退出与不托管的原因（原因同时写进
// 日志，日志取原文），与开口阈值没设时的说法
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'Laya 触发判定',
  triggerLabel: 'Laya 模型',
  thresholdLabel: '开口阈值',
  thresholdDescription: 'logit ≥ 阈值即开口。留空 = 用侧车返回的模型阈值（随模型版本给出）。',
  triggerOnAtLabel: '检测 @ 提及',
  triggerOnAtDescription:
    '@ 自己算"被点名"（戳一戳、名字同理）。点名不强制开口，由模型判定；开口的回合记为 immediate，点名者即授权主体。判定不可用时只回点名。',
  triggerOnPokeLabel: '戳一戳算点名',
  triggerNamesLabel: '点名别名（逗号或换行分隔）',
  muteKeywordsLabel: '禁言关键词（逗号或换行分隔）',
  muteTimeSecondsLabel: '禁言关键词命中时长（秒）',
  mediaWaitMsLabel: '附件识别等待上限（毫秒）',
  mediaWaitMsDescription: '带图片等附件的消息先等识别写好描述再交给模型；超时照常判定，识别在后台继续。',
  endpointLabel: '侧车地址',
  sidecarDirLabel: '侧车目录（由本插件托管）',
  sidecarDirDescription:
    '侧车 laya-listener 所在目录的绝对路径。填了则本插件生效时自己拉起侧车、退出后重启，不再生效或停用时关掉，端口取侧车地址的（地址须为 http://127.0.0.1:<端口>）；留空 = 侧车由外部运行，只按侧车地址连接。',
  timeoutMsLabel: '请求超时（毫秒）',
  timeoutMsDescription: '含读完响应体。超时计一次失败，本条按兜底只回点名。',
  historyRowsLabel: '历史行数',
  historyRowsDescription:
    '窗口的行数，只算 user / assistant 且正文是字符串的行：从 memory 多取一倍，过滤后留最后这么多行。',
  endpointNotHttp: 'plugin-trigger-laya 配置错误：endpoint 须为 HTTP 地址',
  endpointQuery: 'plugin-trigger-laya 配置错误：endpoint 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
  inactive:
    'Laya 触发判定未生效（生效的触发插件是「{label}」），不检查侧车；要启用它，在配置文件的 servicePreferences 里把 trigger 指向 @aalis/plugin-trigger-laya',
  inactiveNone:
    'Laya 触发判定未生效（没有生效的触发插件），不检查侧车；要启用它，在配置文件的 servicePreferences 里把 trigger 指向 @aalis/plugin-trigger-laya',
  active: 'Laya 触发判定生效中：{parts}',
  fallbackNote: '{problems}，判定按兜底只回点名',
  unavailable: '判定不可用（{reason}）',
  stale: '上次判定不可用（{reason}），尚未经请求确认恢复',
  circuitOpen: '侧车连续 {count} 次失败，最近一次：{why}；熔断 {seconds}s 后重试',
  timeout: '超时（{ms}ms）',
  notJson: '响应不是 JSON',
  badLogit: '响应的 logit 不是有限数',
  badThreshold: '阈值不是有限数',
  noMemory: 'memory 缺席，没有历史窗口',
  memoryAbsent: 'memory 缺席',
  online: '侧车在线（版本 {version}）',
  onlineManaged: '侧车在线（版本 {version}，由本插件托管）',
  unreachable: '侧车不可达（{error}）',
  starting: '侧车启动中（已 {seconds}s），就绪前判定按兜底只回点名',
  restartingFor: '侧车重启中（已 {seconds}s，此前连续 {count, number} 次没起来）',
  restarting: '{reason}，{wait}s 后重启（连续 {count} 次）',
  external:
    '侧车不由本插件托管：首次拉起前端口上已有别的侧车在运行；要改由本插件托管，先停掉它（系统服务要卸载），再重启 Aalis 或把 trigger 偏好切走再切回',
  blind:
    '近 {total} 条带图消息有 {count} 条判定时只有图片指针、没有内容描述：media 未开启图片到达即识别（vision.recognizeOnArrival），或没有可用的识别模型',
  notManaged: '不托管侧车：{problem}',
  dirNotAbsolute: 'sidecarDir 须为绝对路径（当前：{dir}）',
  badEndpoint:
    '托管侧车时侧车地址须为 http://127.0.0.1:<端口>（不带路径），侧车只监听本机、端口取自这里（当前：{endpoint}）',
  noProcess: 'process 服务缺席，拉不起侧车',
  spawnFailed: '拉起侧车失败（{error}）',
  exited: '侧车退出（{why}）',
  exitedTail: '侧车退出（{why}；标准错误最后一行：{tail}）',
  startupTimeout: '启动超时：{seconds}s 内没有就绪',
  killedBy: '被信号 {signal} 终止',
  exitCode: '退出码 {code}',
  exitCodeMeaning: '退出码 {code}，{meaning}',
  exit2: '启动失败：加载模型或金样自检没过，或参数、脚本有误',
  exit3: '绑定端口失败',
  exit4: '自愈退出：推理连续失败',
  exit5: '父进程不是 --parent-pid 给的进程',
  restartIn: '{reason}，{seconds}s 后重启',
  // 按会话字段「开口阈值」没设时
  thresholdUnset: '用侧车返回的模型阈值',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-trigger-laya', language: 'zh-CN', source: SOURCE, locales: { en } });

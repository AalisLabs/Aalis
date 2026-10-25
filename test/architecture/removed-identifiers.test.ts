import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 已删除的机制不留痕迹：下表的标识在仓库的代码、测试与文档里一处都不能再出现（CHANGELOG 记的是历史，不查）。
// 删掉一套机制时把它的标识加进来；某个标识日后被正当地重新用上，先改这里的说明再删行。
// ════════════════════════════════════════════════════════════

const ROOT = join(__dirname, '../..');
const SCAN_DIRS = ['packages', 'docs', 'test', 'src'];
const SCAN_FILES = ['README.md', 'CONTRIBUTING.md', 'package.json', 'knip.json', 'biome.json'];
const SKIP_DIRS = new Set(['node_modules', 'dist']);
/** 文档站的构建缓存 */
const SKIP_PATHS = new Set([join(ROOT, 'docs/.vitepress/cache')]);
const TEXT = /\.(ts|tsx|mts|js|mjs|md|json|ya?ml|vue|css)$/;
const SELF = relative(ROOT, __filename);

/** [标识, 删掉的是什么] */
const REMOVED: Array<[string, string]> = [
  ['session-confirm', '会话内文本确认的插件与契约，由 owner 审批与指令的意图确认取代'],
  ['setConfirmHandler', 'authority 的确认通道注册表'],
  ['inbound:confirm', '网关为文本确认回复设的入站相位'],
  ['TemporaryGrant', '确认后的临时授予'],
  ['createTempGrant', '确认后的临时授予'],
  ['revokeTemporaryGrant', '确认后的临时授予'],
  ['autoConfirmUntil', 'owner 限时免确认（/auto）'],
  ['pendingConfirm', '旧前端把下一句输入当确认回复'],
  ['确认相位', '网关为文本确认回复设的入站相位'],
  ['确认通道', 'authority 的确认通道注册表与各平台登记的确认通道'],
  ['自动确认', 'owner 限时免确认（/auto）'],
  ['WSIncomingSchema', 'WebUI 旧 /ws 协议，由会话协议与管理面推送取代'],
  ['WSOutgoing', 'WebUI 旧 /ws 协议，由会话协议与管理面推送取代'],
  ['subscribe_session', 'WebUI 旧 /ws 协议，由会话协议与管理面推送取代'],
  ['page_refresh', 'WebUI 旧 /ws 协议，由会话协议与管理面推送取代'],
  ['useDetailStream', '旧 WebUI 客户端'],
  ['aalis:activeSessionId', '旧 WebUI 客户端把当前会话存在浏览器里'],
  ['__new_chat__', '旧 WebUI 客户端的新会话哨兵'],
  ['DashboardPage', '旧 WebUI 客户端的仪表盘'],
  ['DynamicPage', '旧 WebUI 客户端的声明式页面渲染'],
  ['PluginConfigPage', '旧 WebUI 客户端的插件配置页'],
  ['fileRoot', 'WebUI 的文件管理页'],
  ['/api/files', 'WebUI 的文件管理页'],
  ['FilesPage', 'WebUI 的文件管理页'],
  ['uploaded-files', 'WebUI 宿主写死的上传文件列表'],
  ["services.get('file-reader')", 'WebUI 宿主按名探测上传文件的提供者'],
  ['/api/status', 'WebUI 的状态接口（按名探测上传能力）'],
  ['/api/tool-groups', 'WebUI 仪表盘的工具分组接口'],
  ['/api/llm-models', 'WebUI 仪表盘的模型列表接口'],
  ['/api/service-groups', 'WebUI 仪表盘的服务分组接口，插件区改按插件列表的 subsystem 分组'],
  ['ROOM_ONLY_CONFIG_KEYS', '写死的房间专属设置键：设置项改由字段声明适用的会话种类（appliesTo）'],
  ['omitRoomOnlyKeys', '写死的房间专属设置键：设置项改由字段声明适用的会话种类（appliesTo）'],
  ['sessionListSection', '会话列表分区函数，由会话种类函数 sessionKind 取代'],
  ['getPlatformProfiles', '平台档写在会话管理的插件配置里，改为宿主配置文档的 sessionConfig 按层读写'],
  ["'session:compress'", '压缩请求事件（没人监听也照样成功），由压缩服务 compression 取代'],
  ['DIFF_SOURCES', '审批事实按工具名写死的 diff 来源，由工具定义上声明的展示种类 display 取代'],
  ['enableSelfProfile', 'user-profile 的自档案：模型反思自己的输出再注入回所有会话'],
  ['selfReflectEveryNMessages', 'user-profile 的自档案'],
  ['selfReflectHistory', 'user-profile 的自档案'],
  ['maxSelfFacts', 'user-profile 的自档案'],
  ['selfFacts', 'user-profile 的自档案'],
  ['__self__', 'user-profile 的自档案键前缀'],
  ['profile.self', 'user-profile 查看与清空自档案的两条指令'],
  ['自档案', 'user-profile 的自档案'],
  ['自反思', 'user-profile 的自档案'],
  ['enableInstructions', 'user-profile 的第三方行为指令：从管理员发言里提取行为规则再注入所有会话'],
  ['instructionMinAuthority', 'user-profile 的第三方行为指令'],
  ['instructionExtractEveryNMessages', 'user-profile 的第三方行为指令'],
  ['instructionHistoryForExtraction', 'user-profile 的第三方行为指令'],
  ['maxInstructions', 'user-profile 的第三方行为指令'],
  ['maxInstructionCharsPerItem', 'user-profile 的第三方行为指令'],
  ['aalis:instructions', 'user-profile 的第三方行为指令存储的元数据命名空间'],
  ['user-profile-instructions', 'user-profile 清理第三方行为指令的回执来源'],
  ['第三方行为指令', 'user-profile 的第三方行为指令'],
  ['第三方行为准则', 'user-profile 注入的第三方行为指令块'],
  ['registerPage(', '页面与页面动作分两次登记、靠字符串名对上的旧接口，由 definePage 一次给出取代'],
  ['registerAction(', '页面与页面动作分两次登记、靠字符串名对上的旧接口，由 definePage 一次给出取代'],
  ["renderer: '", '页面交给界面内置渲染器的 renderer：页面默认声明式、需要自绘时用插件前端，权限页改为声明式页面'],
  ['WebuiFilePayload', '文件列以 base64 载荷回传文件，改为交存储地址、由宿主签发下载句柄'],
  ['/api/page-action', '旧的页面动作路由，由按组件取数与按动作调用的两条路由取代'],
  ['TAB_TITLES', '客户端写死的会话面板标签名，由 api-webui 的宿主标签集合 HOST_PANEL_TABS 与标签合成取代'],
  ['SESSION_TABS', '客户端写死的会话面板标签，由 api-webui 的宿主标签集合 HOST_PANEL_TABS 与标签合成取代'],
  ['thinkingMode', 'DeepSeek 的思考开关配置，由模型声明的思考档位与实例的默认档 thinking 取代'],
  ['reasoningEffort', 'DeepSeek 的推理强度配置，并进思考档位'],
  ['exec_background', 'plugin-tool-system 的后台命令，并进 exec：可转后台的工具由执行器转后台并登记成后台任务'],
  ['process_list', 'plugin-tool-system 的后台进程工具，由执行器的后台任务工具 background_list 等取代'],
  ['process_read', 'plugin-tool-system 的后台进程工具，由执行器的后台任务工具 background_output 取代'],
  ['process_kill', 'plugin-tool-system 的后台进程工具，由执行器的后台任务工具 background_stop 取代'],
  ['exec-bg:', '后台命令结束通知的来源前缀，由后台任务结束通知的 bg: 取代'],
  ["'exec-background'", '后台命令结束通知的种类，由后台任务结束通知的 background-task 取代'],
  ['ChildSessions', '左栏会话行上的子任务展开：左栏只列根会话，子会话在会话面板的「后台」标签里按会话树列出'],
  ['getTree', '会话管理服务的整棵会话树接口：没有调用方，会话树按 parentId 经 getChildren 逐层取'],
  ['SessionTreeNode', '会话管理服务的整棵会话树接口'],
  ['FileReaderService', 'plugin-file-reader 的 file-reader 服务：没有消费方，描述符又定义在实现包里'],
  ['stripFileBlocks', '会话服务按文件读取插件的私有格式剥掉提问里的文件块，由存档另记的发言人写的话与附件清单取代'],
  ['better-sqlite3', 'memory-sqlite 依赖的原生 SQLite 模块，由 Node 自带的 node:sqlite 取代'],
  ['AdapterGroup', 'create-aalis 的同类适配器组，由对话模型、平台与语义记忆几问取代'],
  ['baseEnabled', 'create-aalis 按档算基础集，由按所选算插件集的 pluginSet 取代'],
  ['fullCatalog', 'create-aalis 的 full 档目录，并进 pluginSet'],
  ['MarketPackage', 'WebUI 市场页自带的包类型，改用 api-webui 的 MarketplacePackage 与 SystemComponent'],
  ['vnd.npm.install-v1', '市场按精简元数据取整份版本清单，改取每包的 /{包}/latest'],
  ['missingServices', 'webui-server 只看直接提供者的缺服务判据，由 api-doctor 沿依赖链追到根的 unmetDependencies 取代'],
  ['trimHistory', '记忆后端按保留条数归档，由全量压缩落定用的 archiveSpan 取代'],
  ['archiveOldest', '记忆后端归档最早的若干条活跃消息，由能留下其中几条原文的 archiveSpan 取代'],
  ['autoThreshold', '压缩服务的全局自动压缩线，由按会话取的 compressAt 取代'],
  ['autoCompressThreshold', '摘要插件的全局自动压缩线配置，由会话设置项 compressAt 取代'],
  ['selectMessagesToSummarize', '摘要插件按保留条数选待摘要区间，由全量压缩的切分点取代'],
  ['getHistoryProbeLimit', '摘要插件按条数探测历史，由全量压缩读全部活跃历史取代'],
  ['DEFAULT_SUMMARY_PROMPT', '摘要插件的内置摘要提示词，由按房间类别选的两套结构化摘要模板取代'],
  ['summaryTokenRatio', '摘要插件按会话窗口的比例定摘要的输出上限，由按压掉内容的比例定预算的 summaryBudgetRatio 取代'],
  ['createdBy', '会话的创建者类型（没有读者），由只在建档时写的创建来源 createdFrom 取代'],
  ['inferSessionScope', '按会话 id 约定推断会话类型与目标，由会话记下的聊天窗口 originChat 取代'],
  ['OWNER_ENTRY_PLATFORMS', '会话管理按入口平台名单判自动标题，由会话的创建来源 createdFrom 取代'],
  ['agent.historyLimit', '对话代理按运行态配置读历史条数的写法：historyLimit 是可按会话覆盖的字段，经读取器读'],
  ['RoomAudience', '会话的受众（按会话 id 推出），由聊天窗口 originChat 的类型名与多方标记取代'],
  ['AUDIENCE_NAMES', '白纸插件里受众条目的称呼，由层表的称呼加平台与类型名取代'],
  ['resolveSessionOrigin', '按会话 id 推出出生平台与受众，由会话记下的出生平台与聊天窗口取代'],
  ['SessionOrigin', '按会话 id 推出的出生平台与受众，由会话记下的出生平台与聊天窗口取代'],
  [
    'defaultLLM',
    '对话代理的插件配置键 defaultLLM（激活时改 llm 服务的偏好）：默认模型是对话代理的本插件服务偏好，经会话设置「模型」的全局（插件配置）层改',
  ],
  ['ServiceRef', '单层的服务引用（current / require / all），由选择层 ServiceSelection 与业务层 use 两层取代'],
  ['serviceRef', '单层的服务引用的构造函数'],
  ['createStorageGateway', '消费方在 storage 各条目之间路由的网关：storage-local 只登记一个提供者，根在它内部路由'],
  ['createProcessGateway', '消费方取 process 提供者的网关，由业务层 caps.process.use 取代'],
  ['getStorageEntries', 'storage 网关的条目枚举'],
  ['aggregateStorageRoots', 'storage 网关跨条目汇总根'],
  ['resolveStorageEntryForRoot', 'storage 网关按根名找条目'],
  ['resolveStorageByPath', 'storage 网关按宿主路径找条目'],
  ['StorageProviderEntry', 'storage 网关的条目类型'],
  ['AggregatedStorageRoot', 'storage 网关跨条目汇总的根类型'],
  ['StorageRootConflict', 'storage 网关的同名根冲突类型'],
  ['StorageCapability', '存储能力声明的类型（含 StorageCapabilityRegistry）：存储业务层恒定义全部方法'],
  ['StorageCapabilities', '存储能力声明的常量表'],
  ['PlatformAdapterEntry', '平台适配器条目类型，由选择层的 ProviderEntry 取代'],
  ['getPlatformAdapterEntries', '平台适配器条目枚举，由选择层的 list() 取代'],
  ['RemoteAgentEntry', '远端代理提供者条目类型，由选择层的 ProviderEntry 取代'],
  ['migrate-config-0.14', 'schema-config 0.14 的一次性配置迁移工具与它的说明（迁移由代理做，不放进仓库）'],
  ['migratePluginConfig', 'schema-config 0.14 的一次性配置迁移工具'],
  ['before-schema-0.14', '配置迁移工具写下的备份文件后缀'],
  // 会话设置并进插件配置（字段写 session、apply 里经 fields() 取读取器），会话设置拆成 @aalis/plugin-session-settings。
  // 旧的配置类型 SessionConfig 与解析方法 resolveConfig 按子串查会误中（新的 SessionConfigDoc、别的插件自己的 resolveConfig），
  // 只列不会误撞的写法
  ['`SessionConfig`', '会话管理的配置类型（各插件经 declaration merging 加键）'],
  ['interface SessionConfig ', '会话管理的配置类型（各插件经 declaration merging 加键）'],
  ['session-manager.resolveConfig', '会话管理按继承链解析设置，由读取器的 get 取代'],
  ['.use.resolveConfig(', '会话管理按继承链解析设置，由读取器的 get 取代'],
  ['resolveConfig(sessionId', '会话管理按继承链解析设置，由读取器的 get 取代'],
  ['registerSetting', '会话管理的设置项登记，改为 configSchema 字段写 session、apply 里调 fields()'],
  ['RegisteredSessionSetting', '会话管理的已登记设置项类型'],
  ['listSettings', '会话管理列已登记设置项的方法，由读取门面的 getAll 取代'],
  ['SettingProminence', '会话管理设置项的显眼程度类型，挪进字段声明的 session.prominence'],
  ['SessionConfigPatch', '会话管理写会话设置的补丁类型'],
  ['StoredSessionConfig', '会话记录上原样存的设置覆盖（SessionInfo.config），值改存在会话记录的 metadata 里'],
  ['SessionConfigError', '写会话设置被拒的错误，由 api-session-settings 的 SessionSettingsError 取代'],
  ['SessionConfigLayer', '会话管理的层标识，由 api-session-settings 的 SessionSettingsLayer 取代'],
  ['SessionInheritance', '会话管理的继承链解析结果，解析改在 api-session-settings 的 resolveFields 一处'],
  ['InheritanceSource', '会话管理继承链的来源层，由 api-session-settings 的 SessionSource 取代'],
  ['resolveInheritance', '会话管理按继承链解析设置，由读取器的 get 取代'],
  ['getOwnConfig', '会话管理取会话自己的设置覆盖'],
  ['listLayers', '会话管理列可设的层，由管理面的 layers 取代'],
  ['resolveLayer', '会话管理解析一层的设置，由管理面的 rows 取代'],
  ['updateLayer', '会话管理写一层的设置，由管理面的 update 取代'],
  ['BoundSessionManager', '会话管理带设置登记的业务层，会话管理的描述符不再另加方法'],
  ['childConfig', '建子会话时复制的父会话配置，改为建立时由管理面的 childMetadata 写下父会话此刻的生效值'],
  ['resolvedDefaults', '会话管理的全局默认层，全局层就是插件配置'],
  ['preferenceBacked', '全局默认层由服务偏好承担的设置项，改为字段声明的 session.preference'],
  ['liveOnly', '只经继承链实时解析的设置项：子会话建立时写下父会话此刻的生效值，之后独立'],
  ['useDelegatedService', 'WebUI 服务偏好里「默认模型在会话默认里设」的特判'],
  ['session:config:changed', '会话设置变了的事件，由 session-settings:changed 与宿主的 host-config:changed 取代'],
  ['resolveEffectiveConfig', '回复策略按作用域取覆盖，参数改为可按会话覆盖的字段'],
  ['extractTargetId', '回复策略作用域的目标段，作用域由「生效范围」字段取代'],
  ['MEMORY_RECALL_SCOPE_SETTING', '共享的记忆召回范围设置项，各记忆插件改用自己的范围字段'],
  ['memoryRecallScope', '共享的记忆召回范围设置项，各记忆插件改用自己的范围字段'],
  ['MemoryRecallScope', '共享的记忆召回范围的取值类型'],
  ['defaultProvider', '子任务插件的模型提供者配置，由可按会话覆盖的「子任务模型」取代'],
  ['summaryModelMode', '记忆摘要的「摘要模型来源」开关，模型改在插件的服务偏好里设'],
  ['gateway-scopes', 'WebUI 宿主按类型名拼回复策略作用域的可选项来源，作用域由「生效范围」字段取代'],
  ['getPersonaSkills', '人设卡上的技能名单，由技能插件可按会话覆盖的「启用的技能」取代'],
  ['skipArchive', '出站附件跳过归档的标记：发出去的都记，出站记历史只由 message-archive 的 recordOutbound 做'],
  ['inboxRecords', 'webui-server 自己记 WebUI 会话的出站，改由 message-archive 的 recordOutbound 记'],
  [
    'isScopeEnabled',
    '按平台与类型名匹配的作用域判定：回复策略的由「生效范围」字段与 audienceIncludes 取代，检查点的由可按会话覆盖的 coverage 取代',
  ],
  // 含 markExecUsed、rewindExecUsed
  ['execUsed', '检查点按工具名认「这一轮跑过命令」的标记与查询：回滚对话框固定写明命令与外部工具的效果撤不回'],
  ['turn/checkpoint', '会话协议里回滚之前查这一轮跑没跑命令的方法'],
  ['rewindCheckFailed', '回滚对话框查不到这一轮跑没跑命令时的提示'],
  ['getPluginGroups', 'agent 服务按写死的服务名列出的插件分组，没有调用方'],
  ['PluginGroupInfo', 'agent 服务按写死的服务名列出的插件分组，没有调用方'],
  ['getPreprocessors', 'agent 服务列出已登记的预处理器，没有调用方'],
  ['PreprocessorInfo', 'agent 服务列出已登记的预处理器，没有调用方'],
  ['isTimeInjectionEnabled', '人设服务报告是否注入了时间，系统工具据此不登记 system_time：现在照样登记'],
  ['BuildContextOptions', 'media 服务上转调识图上下文的 buildContext，没有调用方'],
  ['registerAccessChecker', '会话历史服务的访问检查器链，由会话管理的取别的会话的规则（canTake）取代'],
  ['AccessChecker', '会话历史服务的访问检查器链，由会话管理的取别的会话的规则（canTake）取代'],
  ['AccessDecision', '会话历史服务的访问检查器链，由会话管理的取别的会话的规则（canTake）取代'],
  ['AccessCheckArgs', '会话历史服务的访问检查器链，由会话管理的取别的会话的规则（canTake）取代'],
  ['registerOneBotHistoryAccessChecker', 'OneBot 工具插件登记的会话历史访问规则，由会话管理的规则取代'],
  ['allowGroupReadPrivate', 'OneBot 工具插件读历史的开关，并进会话管理的「读别人的私聊」'],
  ['allowCrossPrivate', 'OneBot 工具插件读历史的开关，并进会话管理的「读别人的私聊」'],
  ['allowCrossGroup', 'OneBot 工具插件读历史的开关，换成会话管理的「读别的群」'],
  ['allowCrossSelf', 'OneBot 工具插件读历史的开关，换成会话管理的「跨机器人账号」'],
  ['ROOM_DENIAL', '审批服务给房间里的回合的通用拒绝：发起类别不再看会话，回给模型的话一律按固定格式'],
  ['callerUserId', '后台任务结束通知上那次调用的发言者，由续做带着的起它的那一轮 fromTurn 取代'],
  ['owner-chain', '发起类别「owner 链的延续」：续做与它延续的那一轮同一类别'],
  ['noticeCallers', 'agent 让起它的人说话就停下续做的那套：新消息怎么对待在跑的一轮归通道层'],
  ['lastPrincipal', '触及服务记的父会话最近一次签发凭据那一轮的主体：子任务改随派它的那一轮'],
  ['spawnedBy', '触及服务记的子会话由哪一轮派出：子任务改随任务消息带着的那一轮'],
  ['markTainted', '触及服务记会话的污点：经工具读进来的内容不算污染，权限不按上下文里出现过谁收紧'],
  ['provenanceOf', '触及服务查白纸的来源记录，随污点删掉'],
  ['ProvenanceRecord', '白纸来源记录的一条，随污点删掉'],
  ['othersContent', '触及里干净回合的沙箱读不到的别人的内容，随污点删掉'],
  ['provenanceDeny', '沙箱策略里干净回合拒读拒写别人的内容的一段，随污点删掉'],
  ['noteWrite', '触及凭据把受污染回合写进白纸的文件记进来源记录，随污点删掉'],
  ['SECRET_TEXT', '审批服务按内容猜密钥、整段不给改动：改动一律照给'],
  ['SECRET_PATH', '审批服务按路径猜放密钥的文件、整段不给改动：改动一律照给'],
  ['patchHidden', '终端与聊天审批的卡上改动被整段不给时的说明：改动一律照给'],
  ['approvalPatchHidden', 'WebUI 审批卡上改动被整段不给时的说明：改动一律照给'],
  ['ANSWER_LIMIT', '聊天审批按长度猜不是应答：引用了审批消息的应答词不论长短都算'],
  ['quoteToAnswer', '聊天审批对没引用审批消息的应答词回「请引用」：没引用的一律是交给这一轮的普通消息'],
  ['SECRET_WORDS', '沙箱环境按名字里的词猜凭据：沙箱里的命令拿到完整的登录环境'],
  ['SECRET_SEGMENTS', '沙箱环境按名字的分段猜凭据：沙箱里的命令拿到完整的登录环境'],
  ['URL_WITH_PASSWORD', '沙箱环境按值里带密码的网址猜凭据：沙箱里的命令拿到完整的登录环境'],
  ['SECRET_NAMES', '沙箱环境按变量名认凭据的名单：本实例的变量改按命名空间去掉，别的照样带上'],
  ['GIT_CONFIG_ENV', '沙箱环境整组去掉登录环境里的 git 命令行配置：原有的照留，注入的接在后面编号'],
  ['laneKey', 'agent 按会话加来源分道、同一道的新消息中止旧回合：每个会话同一时刻最多一轮，新消息不打断（通道层）'],
  ['archiveIncomingMessageInOrder', 'agent 按道串行的入站归档队列：输入改在进入一轮时归档'],
  ['settledBySubtask', 'WebUI 工具卡上子任务的审批不转交的结算原因：子任务里的审批与主会话同一规则'],
  ['不上浮', '子任务里的审批一律拒：子任务与续做一样随起它的那一轮，推送按根会话'],
  ['normalizeAssistantContent', 'agent 剥标记连同修表格分隔行：agent 不改写表格分隔行，WebUI 渲染时修'],
  ['CONTENT_FILTER_PATTERNS', '模型插件按响应体里的关键词把 400 改说成内容审查：报错照上游原话'],
  ['parseApiError', '模型插件按响应体里的关键词把 400 改说成内容审查：报错照上游原话'],
  ['redactUrl', '模型插件在日志与报错里去掉 baseUrl 的查询串：带查询串或片段的 baseUrl 读配置时就拒绝'],
  ['parseDsmlToolCalls', 'deepseek 插件把正文里漏出的工具调用标记解析成调用去执行：只剥离，工具调用只取服务端给的'],
  ['stripAudioDataPrefix', 'Ollama 插件把没写明类型的音频当 wav 发：认不出的音频格式在发请求前报错'],
  ['sendActionWithRetry', 'onebot 发消息失败（含超时）自动重发：发送不重试，超时或回执前断线记结果未知'],
  ['SEND_MAX_RETRIES', 'onebot 发消息失败（含超时）自动重发：发送不重试，超时或回执前断线记结果未知'],
  ['SEND_RETRY_DELAY_MS', 'onebot 发消息失败（含超时）自动重发：发送不重试，超时或回执前断线记结果未知'],
  ['ActionTimeoutError', 'onebot 只把超时当结果未知：没等到回执（超时、在飞时断线或停止）一律 ActionUnconfirmedError'],
  ['getAnyOneBotSelfId', 'tool-onebot 不在 OneBot 会话里时取第一个账号：只有一个已知账号才用它，多个时要写 self_id'],
  ['fetchForwardOnce', 'onebot 合并转发出错就换参数键重试：只按 v11 标准的 id 拉，错误原样抛出'],
  ['m_resid', 'onebot 合并转发出错就换参数键重试：只按 v11 标准的 id 拉'],
  ['res_id', 'onebot 合并转发出错就换参数键重试：只按 v11 标准的 id 拉'],
  ['checkAdminPermission', 'tool-onebot 的权限预检把不够权限写成返回文字：改为抛错，执行层按失败记'],
  ['rewritePlaceholdersWithRefs', 'onebot 入站按「[图片]」字样对位挂附件引用：按消息段渲染，引用写在段的位置'],
  ['KIND_PLACEHOLDER', 'onebot 入站按「[图片]」字样对位挂附件引用：按消息段渲染，引用写在段的位置'],
  ['INVITE_CARD_SUPPRESS_WINDOW', 'onebot 收到入群邀请后 2 分钟内丢同一人的卡片：私聊里按应用名认入群邀请卡片'],
  ['shouldSuppressInviteCardMessage', 'onebot 收到入群邀请后 2 分钟内丢同一人的卡片：私聊里按应用名认入群邀请卡片'],
  ['rememberInviteCardSuppression', 'onebot 收到入群邀请后 2 分钟内丢同一人的卡片：私聊里按应用名认入群邀请卡片'],
  ['inviteCardSuppressionKey', 'onebot 收到入群邀请后 2 分钟内丢同一人的卡片：私聊里按应用名认入群邀请卡片'],
  ['MAX_FORWARD_IDS_PER_MESSAGE', 'onebot 按正文扫转发标记取 id、每条封顶 8 个：转发 id 只取 forward 段，不封顶'],
  ['getInlineNodes', 'onebot 嵌套转发按节点渲染出的文字取 id：只取节点内容里的 forward 段'],
  [
    'ATTACHMENT_KIND_LABEL',
    'plugin-media 本地的附件种类到引用种类的映射：由 schema-message 导出的 ATTACHMENT_REF_KINDS 取代',
  ],
  ['XML 属性引号转义', 'json-repair 专为 QQ 表情标签加的一步：字符串里的属性引号由裸引号转义处理'],
  ["补全缺失的 '}' 与 ']'", 'json-repair 补齐被截断的括号：截断由模型插件报的结束原因认'],
  ['util-media-signature', '只认媒体的文件头签名包：改名 util-file-signature，另认文档、文本与动图'],
  ['MEDIA_HEAD_BYTES', '只认媒体的文件头长度：改名 FILE_HEAD_BYTES'],
  ['guessAudioExt', '语音识别按路径、Content-Type 与 data URL 写的类型猜上传文件名：按内容判定的格式取'],
  ['WHISPER_EXTS', '语音识别接口收的扩展名表，按它挑路径后缀：接口收的是判定出的格式集合'],
  ['guessExtFromMime', 'media 下载件按网址扩展名与 Content-Type 猜后缀：取判定出的格式'],
  ['SafeFetchResult', 'media 下载带回上游的 Content-Type：只交字节，类型按文件头判'],
  ['fmtToMime', 'media 按另一份文件头表的结论配音频 MIME：取判定出的 MIME'],
  ['ANIMATED_EXTS', 'media 按扩展名认动图：按读到的字节判'],
  ['animatedHints', 'media 按适配器报的 mimeType 登记动图线索：按读到的字节判'],
  ['rememberAnimated', 'media 按适配器报的 mimeType 登记动图线索：按读到的字节判'],
  ['VIDEO_FAILURE_SET', 'media 描述缓存按失败文案认识别失败：失败作为结果交出，调用方不写进缓存'],
  ['animatedPng', '作品审核自带的 APNG 判定：并进 util-file-signature 的 isAnimatedImage'],
  ['animatedWebp', '作品审核自带的动态 WebP 判定：并进 util-file-signature 的 isAnimatedImage'],
  ['isAnimatedFormat', 'media 按 data URL 前缀与扩展名判动图：按读到的字节判'],
  ['isFailurePlaceholder', 'media 描述缓存按文字前缀认识别失败：失败作为结果交出，调用方不写进缓存'],
  ['detectExtensionFromBuffer', 'onebot 落盘的简化文件头表与按种类兜底的扩展名：取共用判定的格式，认不出的落 .bin'],
  ['detectAudioFormat', 'media 交给模型的音频另写的一份文件头表（ftyp 一律当 m4a）：用共用判定'],
  [
    'safeDownloadToTemp',
    'media 下载网址写成临时文件的另一份帮手：下载后与已读到的字节同经 materializeBytes 落临时文件',
  ],
  [
    'imageOnly',
    'media 安全下载的「只收图片」选项：analyze_image 与别的来源同经 readSourceBytes 读，按文件头判在调用处',
  ],
  ['localImageToDataUri', 'tool-onebot 自己读 get_image 给的存储地址转 data URI：交原地址，由 media 按文件头认'],
  // 下面几个名字别处另有同名的在用（plugin-media 的 guessMime、几个插件的 toUri、api-storage 的 STORAGE_URI_RE、白纸的
  // MEDIA_TYPES），按名字登记会误撞，登记删掉的那一份的写法
  ['guessMime(path', 'office 按路径扩展名猜插图的 MIME：按文件头判定的格式取'],
  ['toUri(String(args.', 'office 的 pdf_convert 按「:/」认存储地址：走 api-storage 的 resolveAgainstCwd'],
  ['STORAGE_URI.test(uri)', 'WebUI 服务端 /api/media 自带的存储地址正则：按 api-storage 的 isStorageUri 认'],
  [
    'STORAGE_URI.test(src)',
    'WebUI 客户端认媒体地址自带的存储地址正则（file: 也算）：按 api-storage 的 isStorageUri 认',
  ],
  ['MEDIA_TYPES[', 'WebUI 服务端 /api/media 的格式到 MIME 表：只留放行的格式集合，MIME 取判定结果'],
  ['imageMimeFromPath', 'tool-onebot 按扩展名定本地图的 MIME：读出来按文件头认'],
  ['TYPE_EXTENSIONS', '白纸成品发出前核对远端给的原扩展名：类型按内容判定，发出名由宿主按判定类型重写'],
  ['findCachedToolResult', 'file-reader 在会话历史里找旧的工具结果冒充已清理的文件：如实说找不到、请用户重新上传'],
  ['dataUrlToBuffer', 'file-reader 只认 base64 data URL 取附件字节：按来源取（data URL、存储地址、网址）'],
  ['inferMimeType', 'file-reader 先信附件报的 MIME、再按扩展名查表：按内容判'],
  ['TEXT_MIME_TYPES', 'file-reader 按 MIME 认文本的表：按内容判'],
  ['EXT_MIME_MAP', 'file-reader 按扩展名推 MIME 的表：按内容判'],
  ['extractTextFromBuffer', 'file-reader 按 MIME 分流、读不出时写方括号占位：按内容分流，交结构化的提取结果'],
  ['isTransientExtractionFailure', 'file-reader 按占位文字认能不能缓存：提取结果自带能不能重试'],
  ['textCache', 'file-reader 元信息里缓存的提取文字：缓存结构化的提取结果'],
  ['TEXT_TYPES', 'WebUI 附件按扩展名表决定能不能预览：点开时按内容判'],
  ['previewTooLarge', 'WebUI 附件预览太大时弹框写原因：超过上限的直接下载'],
  ['previewNotText', 'WebUI 附件预览不是文本时弹框写原因：用读到的字节直接下载'],
  // 别处另有同名的 readText 在用，按名字登记会误撞，登记删掉的那一份的写法
  ['readText(href', 'WebUI 附件预览按文字读、只看有没有 NUL：读字节后按内容判'],
];

/**
 * [标识, 删掉的是什么]：页面契约第一版的写法。界面客户端的菜单项也有 danger、表格也有自己的搜索框，
 * 质量门槛的测试要写出这些旧写法来验证它们被拒收，这几处不查（PAGE_SYNTAX_EXEMPT）
 */
const REMOVED_PAGE_SYNTAX: Array<[string, string]> = [
  ['refresh:', '页面、表格与关系图的定时刷新，改由插件在数据变化处 invalidate'],
  ['danger:', '页面动作的 danger，由效果 effect 取代'],
  ['searchable', '表格的搜索开关：行数超过一页时宿主自己出搜索框'],
  ["type: 'stat'", '统计组件，并进键值组件 info'],
  ["type: 'form'", '表单组件，改为动作带输入'],
  ["type: 'tabs'", '标签页组件，改为页面最外层的标签页排法'],
];
const PAGE_SYNTAX_EXEMPT = [
  'packages/plugin-webui-client/',
  'test/webui-client/',
  'test/plugins/webui-page-check.test.ts',
  'test/plugins/webui-pages.test.ts',
];

/** [包目录, 标识, 删掉的是什么]：只在这个包的源码与 package.json 里查 */
const REMOVED_IN_PACKAGE: Array<[string, string, string]> = [
  ['plugin-webui-server', 'doctor:updated', '旧 /ws 上诊断页的刷新特判'],
  ['plugin-webui-server', 'api-todo-list', '旧 /ws 推送待办'],
  [
    'plugin-webui-server',
    'relationGraphDefaultSpacing',
    '关系图的布局疏密不归 WebUI 管：由提供关系图的插件配置，经关系图组件的 spacing 带到界面',
  ],
  ['plugin-session-manager', 'api-webui', '会话页与它的页面动作，由会话协议取代'],
  ['plugin-checkpoint', 'api-webui', '检查点的页面动作，由会话协议的回滚取代'],
  ['plugin-todo-list', 'api-webui', '待办的页面动作，由会话协议的计划条目与清空取代'],
  // 别的包里有 turnModelInfo 这类局部变量，只在本包查
  ['api-llm', 'ModelInfo', '没有引用方的模型信息类型：模型列表的形状归 api-webui 的 REST 类型'],
  // 常见的变量名，只在存档的写方与读方查
  ['plugin-message-archive', 'fileNames', '存档只记文件名的附件清单，由登记的键 Attachments（种类、名字与地址）取代'],
  ['plugin-session-server', 'fileNames', '存档只记文件名的附件清单，由登记的键 Attachments（种类、名字与地址）取代'],
  ['plugin-session-server', 'listLLMModels', '会话设置写死的可选项，可选项改由字段的 dynamicOptions 指向提供它的服务'],
  ['plugin-session-server', 'api-llm', '会话设置写死的可选项（模型列表）'],
  ['plugin-session-server', 'api-persona', '会话设置写死的可选项（人设列表）'],
  ['api-session-protocol', 'sessionDefaults', '写路径不带子会话默认值：新界面没有编辑它的地方'],
  ['plugin-session-server', 'sessionDefaults', '写路径不带子会话默认值：新界面没有编辑它的地方'],
  ['plugin-user-profile', "'instruct", 'user-profile 查看与增删第三方行为指令的 /instruct 指令族'],
  ['plugin-user-profile', 'api-authority', 'user-profile 只为判第三方行为指令的发言人等级而用的权限服务'],
  ['plugin-user-profile', 'api-persona', 'user-profile 只为按人设名给第三方行为指令分堆而用的人设服务'],
  // 常见的词，只在压缩的契约与实现里查
  ['api-memory', 'keepRecent', '压缩保留最近若干条原文，由全量压缩取代'],
  ['plugin-memory-summary', 'keepRecent', '压缩保留最近若干条原文，由全量压缩取代'],
  // plugin-adapter-onebot 的 forward.summaryPrompt 是合并转发摘要的另一个键，只在摘要插件里查
  ['plugin-memory-summary', 'summaryPrompt', '自定义摘要提示词：一份提示词覆盖两套结构化摘要模板会丢掉结构'],
  // webui-client 另有同前缀的 parsePlatforms（解析平台状态接口），只在这两个包查
  ...['plugin-memory-vector', 'plugin-tool-session'].map((pkg): [string, string, string] => [
    pkg,
    'parsePlatform',
    '按会话 id 第一段取平台的私有函数，由会话管理记下的出生平台 originPlatform 取代',
  ]),
  ['plugin-agent', 'this.historyLimit', '对话代理按插件配置读历史条数，改为按会话设置项 historyLimit 读'],
  ['plugin-maimai', 'formatHelp', '手写的 /maimai 帮助，由指令系统生成的用法取代（查询目标与条数是带说明的位置参数）'],
  // 落盘扩展名表 EXTENSIONS 与留下的 REFUSED_EXTENSIONS 同名，只登记 MIME 表
  ['plugin-paper', 'MIME_TYPES', '白纸按成品类型各写一份的媒体扩展名与 MIME 表：收成成品类型 → 判定格式的一张表'],
  [
    'plugin-tools',
    "'background-task'",
    '执行器私有的结束通知种类，挪进 api-tools 作契约常量 BACKGROUND_TASK_NOTICE，执行器与界面都引用它',
  ],
  // 常见的词，只在聊天审批里查
  ['plugin-chat-approval', 'ASKING', '聊天审批按结尾的问号猜是在问、不是应答：引用了审批消息的应答词照算'],
  // 会话层不认识具体的设置项：设置项是各插件配置里写了 session 的字段，会话管理、会话设置、会话协议与会话服务的源码里不出现
  // 它们的键。只列字面上不会误撞的键（llm、think、persona 这类常用词在这些包里另有正当用法）
  ...[
    'api-session-manager',
    'plugin-session-manager',
    'api-session-settings',
    'plugin-session-settings',
    'api-session-protocol',
    'plugin-session-server',
  ].flatMap(pkg =>
    [
      'paperEnabled',
      'paperName',
      'remoteAgentTypes',
      'remoteAgentUserDailyCents',
      'remoteAgentUserDailyTasks',
      'remoteAgentRoomDailyCents',
      'systemPromptExtra',
      'maxToolIterations',
      'disableOutputFormat',
      'clientSideJsonRendering',
      'enabledToolGroups',
    ].map((key): [string, string, string] => [pkg, key, '具体的设置项是插件配置里的字段，会话层不认识']),
  ),
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name) && !SKIP_PATHS.has(full)) yield* walk(full);
    } else if (TEXT.test(name) && !name.endsWith('-lock.json')) {
      yield full;
    }
  }
}

function scannedFiles(): string[] {
  const files = SCAN_DIRS.flatMap(dir => [...walk(join(ROOT, dir))]);
  for (const name of SCAN_FILES) files.push(join(ROOT, name));
  return files.map(file => relative(ROOT, file)).filter(file => file !== SELF);
}

describe('已删除的机制不留痕迹', () => {
  const files = scannedFiles().map(file => [file, readFileSync(join(ROOT, file), 'utf-8')] as const);
  it.each(REMOVED)('%s（%s）', identifier => {
    const hits = files.filter(([, text]) => text.includes(identifier)).map(([file]) => file);
    expect(hits).toEqual([]);
  });

  it.each(REMOVED_PAGE_SYNTAX)('%s（%s）', identifier => {
    const hits = files
      .filter(
        ([file, text]) => !PAGE_SYNTAX_EXEMPT.some(prefix => file.startsWith(prefix)) && text.includes(identifier),
      )
      .map(([file]) => file);
    expect(hits).toEqual([]);
  });

  it('页面契约旧写法的豁免路径都在：改名或挪走后这份豁免不能悄悄失效', () => {
    for (const prefix of PAGE_SYNTAX_EXEMPT) {
      expect(
        files.some(([file]) => file.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
  });

  it.each(REMOVED_IN_PACKAGE)('%s 里没有 %s（%s）', (pkg, identifier) => {
    const dir = join(ROOT, 'packages', pkg);
    const hits = [...walk(join(dir, 'src')), join(dir, 'package.json')]
      .filter(file => readFileSync(file, 'utf-8').includes(identifier))
      .map(file => relative(ROOT, file));
    expect(hits).toEqual([]);
  });
});

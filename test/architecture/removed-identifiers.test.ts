import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 已删除的机制不留痕迹：下表的标识在仓库的代码、测试与文档里一处都不能再出现（CHANGELOG 记的是历史，不查）。
// 删掉一套机制时把它的标识加进来；某个标识日后被正当地重新用上，先改这里的说明再删行。
// ════════════════════════════════════════════════════════════

const ROOT = join(__dirname, '../..');
const SCAN_DIRS = ['packages', 'docs', 'test', 'src', 'tools'];
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
  ['ROOM_ONLY_CONFIG_KEYS', '写死的房间专属设置键，由设置项登记的 liveOnly 取代'],
  ['omitRoomOnlyKeys', '写死的房间专属设置键，由会话管理的 childConfig 取代'],
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
  ['trimHistory', '记忆后端按保留条数归档，由全量压缩落定用的 archiveOldest 取代'],
  ['autoThreshold', '压缩服务的全局自动压缩线，由按会话取的 compressAt 取代'],
  ['autoCompressThreshold', '摘要插件的全局自动压缩线配置，由会话设置项 compressAt 取代'],
  ['selectMessagesToSummarize', '摘要插件按保留条数选待摘要区间，由全量压缩的切分点取代'],
  ['getHistoryProbeLimit', '摘要插件按条数探测历史，由全量压缩读全部活跃历史取代'],
  ['agent.historyLimit', '对话代理的插件配置键 historyLimit，由会话设置项 historyLimit（条数线）取代'],
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
  ['plugin-agent', 'this.historyLimit', '对话代理按插件配置读历史条数，改为按会话设置项 historyLimit 读'],
  ['plugin-maimai', 'formatHelp', '手写的 /maimai 帮助，由指令系统生成的用法取代（查询目标与条数是带说明的位置参数）'],
  [
    'plugin-tools',
    "'background-task'",
    '执行器私有的结束通知种类，挪进 api-tools 作契约常量 BACKGROUND_TASK_NOTICE，执行器与界面都引用它',
  ],
  // 会话层不认识具体的设置项：设置项由拥有功能的插件登记，会话管理、会话协议与会话服务的源码里不出现它们的键。
  // 只列字面上不会误撞的键（llm、think、persona 这类常用词在这些包里另有正当用法）
  ...['api-session-manager', 'plugin-session-manager', 'api-session-protocol', 'plugin-session-server'].flatMap(pkg =>
    [
      'paperEnabled',
      'paperName',
      'remoteAgentTypes',
      'remoteAgentUserDailyCents',
      'remoteAgentUserDailyTasks',
      'remoteAgentRoomDailyCents',
      'memoryRecallScope',
      'systemPromptExtra',
      'maxToolIterations',
      'disableOutputFormat',
      'clientSideJsonRendering',
      'enabledToolGroups',
    ].map((key): [string, string, string] => [pkg, key, '具体的设置项由插件登记，会话层不认识']),
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

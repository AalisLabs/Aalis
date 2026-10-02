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
  ['ROOM_ONLY_CONFIG_KEYS', '写死的房间专属设置键，由设置项登记的 liveOnly 取代'],
  ['omitRoomOnlyKeys', '写死的房间专属设置键，由会话管理的 childConfig 取代'],
  ['sessionListSection', '会话列表分区函数，由会话种类函数 sessionKind 取代'],
  ['getPlatformProfiles', '平台档写在会话管理的插件配置里，改为宿主配置文档的 sessionConfig 按层读写'],
  ["'session:compress'", '压缩请求事件（没人监听也照样成功），由压缩服务 compression 取代'],
  ['DIFF_SOURCES', '审批事实按工具名写死的 diff 来源，由工具定义上声明的展示种类 display 取代'],
];

/** [包目录, 标识, 删掉的是什么]：只在这个包的源码与 package.json 里查 */
const REMOVED_IN_PACKAGE: Array<[string, string, string]> = [
  ['plugin-webui-server', 'doctor:updated', '旧 /ws 上诊断页的刷新特判'],
  ['plugin-webui-server', 'api-doctor', '旧 /ws 上诊断页的刷新特判'],
  ['plugin-webui-server', 'api-todo-list', '旧 /ws 推送待办'],
  ['plugin-session-manager', 'api-webui', '会话页与它的页面动作，由会话协议取代'],
  ['plugin-session-manager', 'registerAction(', '会话页的页面动作，由会话协议取代'],
  ['plugin-session-manager', 'registerPage(', '会话页，由会话协议取代'],
  ['plugin-checkpoint', 'api-webui', '检查点的页面动作，由会话协议的回滚取代'],
  ['plugin-checkpoint', 'registerAction(', '检查点的页面动作，由会话协议的回滚取代'],
  ['plugin-todo-list', 'api-webui', '待办的页面动作，由会话协议的计划条目与清空取代'],
  ['plugin-todo-list', 'registerAction(', '待办的页面动作，由会话协议的计划条目与清空取代'],
  ['plugin-session-server', 'listLLMModels', '会话设置写死的可选项，可选项改由字段的 dynamicOptions 指向提供它的服务'],
  ['plugin-session-server', 'api-llm', '会话设置写死的可选项（模型列表）'],
  ['plugin-session-server', 'api-persona', '会话设置写死的可选项（人设列表）'],
  ['api-session-protocol', 'sessionDefaults', '写路径不带子会话默认值：新界面没有编辑它的地方'],
  ['plugin-session-server', 'sessionDefaults', '写路径不带子会话默认值：新界面没有编辑它的地方'],
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

  it.each(REMOVED_IN_PACKAGE)('%s 里没有 %s（%s）', (pkg, identifier) => {
    const dir = join(ROOT, 'packages', pkg);
    const hits = [...walk(join(dir, 'src')), join(dir, 'package.json')]
      .filter(file => readFileSync(file, 'utf-8').includes(identifier))
      .map(file => relative(ROOT, file));
    expect(hits).toEqual([]);
  });
});

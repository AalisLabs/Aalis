// ----- 管理面 REST -----
//
// webui-server 的全部 HTTP 路由，第三方前端照它实现。路由表的键是「方法 路径」，路径照 webui-server 登记的写法：`:name` 是一段
// 路径参数（要 encodeURIComponent），`{*path}` 是其后的任意多段。回 JSON 的在 WebuiRestRoutes，写请求（query 是查询参数，
// body 是请求体）与 2xx 时的回应；回文件或页面的在 WebuiFileRoutes，写请求与 2xx 时的响应头。失败一律回 4xx 或 5xx 与
// ErrorResponse。WebSocket 端点 /session（会话协议，见 api-session-protocol）与 /admin（管理面推送，见 index.ts）不在这里。
// 只有类型：服务端按它约束自己的回应，测试核对实际的回应与它对得上。
//
// 不要登录的只有 /api/auth/ 下的四条与 /frames/ 下的文件；其余要登录（cookie），没登录的 /api/ 请求回 401，页面回登录页。
// 改状态的请求（非 GET）另校验来源：带 Origin 的要与本服务同源。登记表里没有的 /api/ 路径回 404 与 ErrorResponse。

import type { UserIdentity } from '@aalis/api-authority';
import type { InstallResult, UninstallOptions, UpdateResult, UpdateTarget } from '@aalis/api-package-manager';
import type { PlatformConnection } from '@aalis/api-platform';
import type { LogEntry, PluginState } from '@aalis/core';
import type { ConfigSchema, SchemaIssue } from '@aalis/schema-config';
import type { DepOrigin } from '@aalis/util-dep-spec';
import type { AttentionItem, ExtendDeclaration, LogFilter, PluginBlockers } from './index.js';
import type { LayoutOperation, LayoutRecords, PageDataByType, PageRef, PageView } from './page.js';
import type { PluginTheme } from './theme.js';

// ----- 共用 -----

/** 失败的回应（4xx、5xx） */
export interface ErrorResponse {
  error: string;
  /** 输入没过校验时逐项列出 */
  issues?: SchemaIssue[];
  /** 改动已在运行态生效，只是没写进配置文件 */
  applied?: true;
}

export interface OkResponse {
  ok: true;
}

/** 管理动作的回执：message 写做成了什么，动作之后插件没落在预期状态（激活失败、仍在激活等）时也写在这里 */
export interface MessageResponse extends OkResponse {
  message: string;
}

// ----- 认证 -----

export interface LoginRequest {
  token: string;
}

export interface LoginResponse extends OkResponse {
  identity: UserIdentity;
}

export interface AuthStatusResponse {
  authed: boolean;
  /** 登录了才有 */
  identity?: UserIdentity;
}

// ----- 插件 -----

/** GET /api/plugins 的一项：一个插件实例；没起来的原因见 PluginBlockers */
export interface PluginListItem extends PluginBlockers {
  /** 插件包名：同一插件的几个实例按它合在一起 */
  name: string;
  instanceId: string;
  displayName?: string;
  /** 插件声明的子系统，没声明的不给；组名与顺序见 DEFAULT_SUBSYSTEM_METADATA */
  subsystem?: string;
  /** 已装的包的版本，本地查不到的不给 */
  version?: string;
  state: PluginState;
  error?: string;
  /** 激活超过慢激活阈值、已转入后台 */
  slow?: boolean;
  /** 旧实例超过宽限仍未停下：停下之前同一 id 不起新实例 */
  lingering?: boolean;
  /** 提供这个界面：不能从界面停用或卸载 */
  self?: true;
  provides: string[];
  requiredServices: string[];
  optionalServices: string[];
  /** 本插件偏好（用户设的、只对这个实例生效）：服务名 → 偏好的提供者（contextId），只列它声明了的、设了的服务 */
  servicePreferences: Record<string, string>;
  tools: string[];
  commands: string[];
  reusable: boolean;
  extends?: ExtendDeclaration;
  /** 配置文件里有这个实例的配置段（空段也算）：市场卸载时「同时删除配置」看它；宿主不提供配置文档时为 false */
  configSection: boolean;
  /** 配置文档里这一段：密钥字段上是引用 `{ $secret }`；宿主不提供配置文档时是运行态配置，去掉密钥字段 */
  config: Record<string, unknown>;
  configSchema?: ConfigSchema;
  defaultConfig: Record<string, unknown>;
}

export interface PluginListResponse {
  plugins: PluginListItem[];
  /** 密钥键 → 配置文档里引用它的处数 */
  secretRefCounts: Record<string, number>;
}

/** 插件配置的部分更新：提交的顶层键整键替换，值为 null 的视为删除 */
export interface PluginConfigRequest {
  config: Record<string, unknown>;
}

export interface PluginConfigResponse extends MessageResponse {
  /** 本次提交里裁掉的未声明字段 */
  ignored: string[];
  /** 配置文档里原有、随这次写回删掉的未声明字段 */
  removed: string[];
}

export interface InstanceCreateRequest {
  /** 实例 id 是 `<插件名>:<suffix>`：字母、数字、下划线与连字符 */
  suffix: string;
  config?: Record<string, unknown>;
}

export interface InstanceCreateResponse extends MessageResponse {
  instanceId: string;
  ignored: string[];
}

export interface PluginScanResponse extends MessageResponse {
  /** 新加载的插件 */
  loaded: string[];
}

// ----- 宿主配置与服务 -----

export interface HostConfigResponse {
  /** 配置文档里写了的核心键 */
  config: Record<string, unknown>;
  /** 核心键的 schema */
  schema: ConfigSchema;
  /** 要重启才生效的键 */
  restartKeys: string[];
  /** 家目录，宿主不提供路径时没有 */
  home?: string;
}

/** 核心键 → 新值，null 回到默认；只收核心键 */
export type HostConfigRequest = Record<string, unknown>;

export interface HostConfigSaved extends MessageResponse {
  /** 改了的键里有要重启才生效的 */
  restartNeeded: boolean;
}

export interface ServiceProviderView {
  /** 提供者的插件实例 id，宿主自己提供的是 `root` */
  contextId: string;
  displayName?: string;
  label?: string;
  priority: number;
  exclusive: boolean;
}

export interface ServiceListResponse {
  /** 服务名 → 提供者（按偏好、优先级、登记先后排好，第一个就是正在用的）与偏好的提供者 */
  services: Record<string, { providers: ServiceProviderView[]; preferred: string | null }>;
}

export interface PreferRequest {
  contextId: string;
}

// ----- 运行状况、日志与主题 -----

/** 「需要处理」：审批在前，其后是插件故障与提示，各按先后 */
export interface AttentionResponse {
  items: AttentionItem[];
}

export interface PlatformStatus {
  adapterName: string;
  platform: string;
  /** 适配器所在的插件实例 */
  contextId: string;
  connections: PlatformConnection[];
}

export interface PlatformListResponse {
  platforms: PlatformStatus[];
}

/** 日志历史的查询参数：筛选（与 /admin 的订阅同一份）与条数（默认 200，上限 5000） */
export interface LogQuery extends LogFilter {
  limit?: number;
}

/** GET /api/themes：插件此刻提供的主题，按全局键排 */
export interface PluginThemesResponse {
  themes: PluginTheme[];
}

// ----- 可选项与模型 -----

/** 一个可选项：default 标没设时生效的那一项；工具分组另带说明与登记它的插件 */
export interface OptionDetail {
  value: string;
  label: string;
  default?: true;
  description?: string;
  pluginName?: string;
}

/**
 * 可选项来源的回应：models 是取值，details 是带名字的可选项（有它时按它画），labels 是不在可选项里的取值的名字
 * （深度思考的档位：换了模型以后存着的档位不在可选项里，界面按它写名字）
 */
export interface OptionsResponse {
  models: string[];
  details?: OptionDetail[];
  labels?: Record<string, string>;
}

/** 一个模型：contextId 是提供它的插件实例，llm-ref 的取值 `{ provider, model }` 认的是它 */
export interface LLMModelEntry {
  model: string;
  /** 显示名 */
  provider: string;
  contextId: string;
  capabilities: string[];
}

/** 模型服务（llm）的回应 */
export interface LLMModelsResponse {
  providers: LLMModelEntry[];
}

export interface ModelRefreshResponse extends OkResponse {
  added: string[];
  removed: string[];
  total: number;
}

// ----- 页面与布局 -----

export interface PageListResponse {
  /** 按位置内的 order、实例、key 排好 */
  pages: PageView[];
}

export interface PanelPagesResponse {
  pages: PageRef[];
}

/** 声明式页面一个组件的数据，按组件种类 */
export interface PageDataResponse<T extends keyof PageDataByType = keyof PageDataByType> {
  data: PageDataByType[T];
}

/** 插件前端一个数据源的数据：数据源返回的值 */
export interface FrameDataResponse {
  data: unknown;
}

/**
 * 数据路由的查询参数：sessionId 给会话面板，rowKey 给详情里的组件；插件前端的数据源另收 input（JSON 字符串，声明了输入的
 * 数据源才收）。只收用得上的键，多出或缺了都拒收
 */
export interface PageDataQuery {
  sessionId?: string;
  rowKey?: string;
  input?: string;
}

/** 只收这三个键：sessionId 给会话面板，rowKey 给行动作（插件前端没有），input 给声明了输入的动作；多出或缺了都拒收 */
export interface PageActionRequest {
  sessionId?: string;
  rowKey?: string;
  input?: Record<string, unknown>;
}

export interface PageActionResponse {
  /** 处理函数给的一句结果 */
  message?: string;
}

// ----- 市场 -----

/** 组件类别：plugin 可装卸，api 与 schema 只读，interface 是前端界面，util 是工具库 */
export type PackageCategory = 'plugin' | 'api' | 'schema' | 'interface' | 'util';

export interface MarketplacePackage {
  name: string;
  /** 安装源上的最新版，查不到为空串；不是本地已装的版本 */
  version: string;
  description: string;
  author?: string;
  installed: boolean;
  /** 本地已装的版本 */
  resolved?: string;
  /** 根 package.json 里的依赖声明，未装或不是直接依赖时没有 */
  request?: string;
  /** 本地这份从哪来，未装时没有 */
  origin?: DepOrigin;
  /** 此刻能否经市场更新：来源是 registry，且安装源上的最新版严格新于本地。界面直接用它，不自己比版本 */
  updatable: boolean;
  /** `@aalis/` 下的包 */
  official: boolean;
  category: PackageCategory;
  /**
   * 声明提供的服务（package.json 的 `aalis.service.provides`），市场按服务搜靠它：已装的取本地这份（与本地版本对得上），
   * 没装的取安装源上的最新版；都查不到或没声明时为空
   */
  provides: string[];
  /** 关键词，去掉了类型词 */
  keywords?: string[];
  /** 月下载量 */
  downloads?: number;
  /** 最近更新时间（ISO） */
  updated?: string;
  /** npm 的综合评分，只用来排序 */
  score?: number;
  /** npm 标记的不安全包 */
  insecure?: boolean;
  license?: string;
  links?: { npm?: string; homepage?: string; repository?: string };
}

export interface MarketplaceResponse {
  packages: MarketplacePackage[];
  /** 检索源或安装源查不到时的说明 */
  warning?: string;
}

/** 系统组件：本地已装的内核、宿主、契约、规范与工具库 */
export interface SystemComponent {
  name: string;
  /** 本地已装的版本 */
  version?: string;
  /** 安装源上的最新版，查不到时没有 */
  latest?: string;
  request?: string;
  /** 来源分档：已是最新版与查不到最新版都不能更新，从 updatable 推不出来源，所以另给 */
  origin: DepOrigin;
  description?: string;
  kind: 'core' | 'runtime' | 'api' | 'schema' | 'util';
  /** 根 dependencies 里以 semver 范围声明、且最新版严格新于本地 */
  updatable: boolean;
}

export interface SystemComponentsResponse {
  components: SystemComponent[];
  warning?: string;
}

/** 依赖链路的一个节点：present 为 false 是本地没有这个包，链路在此中断 */
export interface DependencyNode {
  name: string;
  present: boolean;
  /** 已加载的插件才有：它提供与要用的服务 */
  services?: { provides: string[]; requires: string[] };
  children: DependencyNode[];
}

export interface DependencyGraphResponse {
  /** 它依赖谁 */
  upstream: DependencyNode;
  /** 谁依赖它 */
  downstream: DependencyNode;
  /** 它要用的服务由谁提供（宿主提供的写「宿主」，没人提供为 null），与它提供的服务 */
  services: { required: Array<{ service: string; providedBy: string | null }>; provides: string[] };
  /** 卸载它会断掉服务的插件 */
  serviceDependents: string[];
}

export interface PackageRequest {
  name: string;
}

/** 卸载：removeConfig 不给为 false，配置段与密钥留着 */
export interface UninstallRequest extends PackageRequest, UninstallOptions {}

export interface UpdateRequest {
  targets: UpdateTarget[];
}

// ----- 路由表 -----

/** 回 JSON 的路由 */
export interface WebuiRestRoutes {
  'POST /api/auth/login': { body: LoginRequest; response: LoginResponse };
  'GET /api/auth/status': { response: AuthStatusResponse };
  'POST /api/auth/logout': { response: OkResponse };

  'GET /api/plugins': { response: PluginListResponse };
  'PUT /api/plugins/:name/config': { body: PluginConfigRequest; response: PluginConfigResponse };
  'POST /api/plugins/:name/enable': { response: MessageResponse };
  'POST /api/plugins/:name/disable': { response: MessageResponse };
  'POST /api/plugins/:name/reload': { response: MessageResponse };
  'POST /api/plugins/scan': { response: PluginScanResponse };
  'POST /api/plugins/:name/instances': { body: InstanceCreateRequest; response: InstanceCreateResponse };
  'DELETE /api/plugins/:instanceId/instance': { response: MessageResponse };
  /** 本插件偏好：只对这个实例生效，校验、持久化与回应同全局偏好的两条 */
  'POST /api/plugins/:instanceId/services/:name/prefer': { body: PreferRequest; response: OkResponse };
  'DELETE /api/plugins/:instanceId/services/:name/prefer': { response: OkResponse };

  'GET /api/config': { response: HostConfigResponse };
  'PUT /api/config': { body: HostConfigRequest; response: HostConfigSaved };
  'POST /api/restart': { response: MessageResponse };
  'GET /api/services': { response: ServiceListResponse };
  'POST /api/services/:name/prefer': { body: PreferRequest; response: OkResponse };
  'DELETE /api/services/:name/prefer': { response: OkResponse };

  'GET /api/attention': { response: AttentionResponse };
  'GET /api/platforms': { response: PlatformListResponse };
  'GET /api/logs/tail': { query: LogQuery; response: LogEntry[] };
  /** 往前翻：seq 比 before 小的最后 limit 条 */
  'GET /api/logs/range': { query: LogQuery & { before: number }; response: LogEntry[] };
  'GET /api/themes': { response: PluginThemesResponse };

  /**
   * 按来源取可选项：llm 回模型；platform、gateway-scopes、toolGroups、llm-thinking 由宿主回答，llm-thinking 收 dependency
   * （模型引用 `{ provider, model }` 的 JSON，没带时按服务偏好）；其余服务合起各提供者的 listModels()，回 `{ models }`
   */
  'GET /api/models/:service': { query: { dependency?: string }; response: LLMModelsResponse | OptionsResponse };
  /** :contextId 是提供者的插件实例，与模型的 contextId 相同 */
  'POST /api/llm-providers/:contextId/refresh': { response: ModelRefreshResponse };

  'GET /api/pages': { response: PageListResponse };
  'GET /api/session-pages': { query: { sessionId: string }; response: PanelPagesResponse };
  'GET /api/pages/:instance/:pageKey/data/:componentId': {
    query: PageDataQuery;
    response: PageDataResponse | FrameDataResponse;
  };
  'POST /api/pages/:instance/:pageKey/actions/:action': { body: PageActionRequest; response: PageActionResponse };
  'GET /api/layout': { response: LayoutRecords };
  'POST /api/layout': { body: LayoutOperation; response: LayoutRecords };

  'GET /api/marketplace': { query: { q?: string }; response: MarketplaceResponse };
  'GET /api/system-components': { response: SystemComponentsResponse };
  'GET /api/marketplace/depgraph': { query: { name: string }; response: DependencyGraphResponse };
  /** 包管理拒绝时也回 200，ok 为 false、message 写原因 */
  'POST /api/marketplace/install': { body: PackageRequest; response: InstallResult };
  'POST /api/marketplace/uninstall': { body: UninstallRequest; response: { ok: boolean; message: string } };
  /** 整批更新，成功后进程重启 */
  'POST /api/marketplace/update': { body: UpdateRequest; response: UpdateResult };
}

/** 下载的文件：一律当附件，不在 WebUI 的源里内联；带长度，界面据它决定能不能预览 */
interface AttachmentHeaders {
  'content-type': 'application/octet-stream';
  'content-disposition': `attachment; ${string}`;
  'content-length': `${number}`;
  'x-content-type-options': 'nosniff';
  'content-security-policy': string;
}

/** 插件前端的文件：框架 CSP 的脚本只认这一页的目录与公用目录 */
interface FrameFileHeaders {
  'content-type': string;
  'content-length': `${number}`;
  'content-security-policy': `sandbox allow-scripts; ${string}`;
  'x-content-type-options': 'nosniff';
  'referrer-policy': 'no-referrer';
  'access-control-allow-origin': '*';
  'cache-control': 'no-cache';
}

/** WebUI 自己的页面与脚本：带文档级 CSP */
interface DocumentHeaders<T extends string> {
  'content-type': `${T}; charset=utf-8`;
  'content-length': `${number}`;
  'content-security-policy': string;
}

/** 回文件或页面的路由：写请求与 2xx 时的响应头（小写，不含 Date、ETag 这类传输层的头） */
export interface WebuiFileRoutes {
  'GET /api/auth/login.js': { headers: DocumentHeaders<'application/javascript'> };
  /** 句柄由会话服务签发，绑定会话 */
  'GET /api/session-file': { query: { sessionId: string; handle: string }; headers: AttachmentHeaders };
  /** 句柄是页面数据里的 FileCell.handle */
  'GET /api/page-file': { query: { handle: string }; headers: AttachmentHeaders };
  /** 存储地址上的图片、视频与音频，按文件头判定类型 */
  'GET /api/media': {
    query: { uri: string };
    headers: {
      'content-type': `${'image' | 'video' | 'audio'}/${string}`;
      'content-disposition': 'inline';
      'content-length': `${number}`;
      'x-content-type-options': 'nosniff';
      'content-security-policy': "sandbox; default-src 'none'";
      'cache-control': 'private, max-age=3600';
    };
  };
  /** 代为取外站的图片 */
  'GET /api/proxy/image': {
    query: { url: string };
    headers: {
      'content-type': `image/${string}`;
      'x-content-type-options': 'nosniff';
      'content-security-policy': 'sandbox';
      'cache-control': 'private, max-age=86400';
    };
  };
  /** 插件前端的文件：token 取自 FramePageView.frame.src；只收 GET 与 HEAD */
  'GET /frames/:token/{*path}': { headers: FrameFileHeaders };
  /** 宿主给框架的助手 */
  'GET /frames/_base/frame.js': { headers: FrameFileHeaders };
  /** 宿主给框架的样式基线 */
  'GET /frames/_base/frame.css': { headers: FrameFileHeaders };
  /** 换前端的恢复页：任何前端卡住时都能在这里切回 */
  'GET /__clients': { headers: DocumentHeaders<'text/html'> };
  'GET /__clients.js': { headers: DocumentHeaders<'application/javascript'> };
  /** 其余 GET：活跃前端的 index.html（前端自己的路由），每次再验证；/assets/ 下没有的文件回 404 */
  'GET /{*path}': { headers: DocumentHeaders<'text/html'> & { 'cache-control': 'public, max-age=0' } };
}

/** 一条 JSON 路由 2xx 时的回应 */
export type WebuiRestResponse<K extends keyof WebuiRestRoutes> = WebuiRestRoutes[K]['response'];

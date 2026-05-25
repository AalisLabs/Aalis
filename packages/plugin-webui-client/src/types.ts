// ===== 共享类型 =====

export interface TodoItem {
  id: number;
  title: string;
  status: 'not-started' | 'in-progress' | 'completed';
}

export type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'reasoning_text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; result?: string; startTime?: number; endTime?: number };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * 派生镜像：所有 reasoning_text 段拼接的字符串。
   * 仅当无 segments（旧数据/老路径）时由历史构建器写入用于回退渲染。
   * 渲染时优先用 segments；本字段保留以兼容仍读它的代码。
   */
  reasoningContent?: string;
  /**
   * 助手输出的有序时间线（text / reasoning_text / tool_call 按真实到达顺序混排）。
   * 存在时为渲染权威依据；不存在时回退到 content + reasoningContent 的两段式。
   */
  segments?: ContentSegment[];
  /** 附带的图片（base64 data URL）*/
  images?: string[];
  /** 附带的文件名列表（仅用于显示） */
  fileNames?: string[];
  /** 助手附件（agent 通过 send_image 等工具产生的图片/媒体）。 */
  attachments?: Array<{ kind: 'image' | 'audio' | 'video' | 'file'; data: string; mimeType?: string; name?: string }>;
  timestamp: number;
}

export interface LogEntry {
  /** 后端进程内单调递增序号；前端用作 React key 与分页 cursor。 */
  seq: number;
  timestamp: string;
  level: string;
  scope: string;
  message: string;
}

export interface CommandInfo {
  name: string;
  description: string;
  authority?: number;
  safety?: string;
}

export interface SystemStatus {
  name: string;
  services: Record<string, boolean>;
  uploadCapabilities?: {
    image: boolean;
    file: boolean;
  };
  tools: string[];
  commands: CommandInfo[];
}

export interface ExtendDeclaration {
  events?: string[];
  hooks?: string[];
  mixins?: Record<string, string[]>;
}

export interface PluginInfo {
  name: string;
  instanceId: string;
  displayName?: string;
  state: string;
  provides: string[];
  /** 该插件注册到全局工具表的工具名列表（用于搜索）。后端 /api/plugins 反向索引。 */
  tools?: string[];
  /** 该插件注册的指令完整名（含分组路径，例如 "plugins.refresh"）。 */
  commands?: string[];
  core: boolean;
  reusable: boolean;
  extends?: ExtendDeclaration;
  config: Record<string, unknown>;
  configSchema?: ConfigSchema;
  defaultConfig?: Record<string, unknown>;
  error?: string;
}

// ----- ConfigSchema 类型 (镜像 core) -----

export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect' | 'textarea' | 'llm-ref';

export interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  secret?: boolean;
  options?: Array<{ label: string; value: string | number }>;
  dynamicOptions?: string;
  /** select 类型的动态提供者列表：填服务名，获取该服务的所有提供者 */
  dynamicProviders?: string;
  allowCustom?: boolean;
}

export interface SchemaGroup {
  label?: string;
  description?: string;
  fields: Record<string, SchemaField>;
}

export interface SchemaArray {
  type: 'array';
  label: string;
  description?: string;
  items: Record<string, SchemaField>;
  default?: unknown[];
}

export type ConfigSchema = Record<string, SchemaField | SchemaGroup | SchemaArray>;

// ----- 平台适配器类型 -----

export interface PlatformConnectionInfo {
  id: string;
  platform: string;
  selfId?: string;
  status: 'online' | 'offline' | 'connecting';
  detail?: Record<string, unknown>;
}

export interface PlatformInfo {
  adapterName: string;
  platform: string;
  contextId: string;
  connections: PlatformConnectionInfo[];
}

export interface ServiceProviderInfo {
  contextId: string;
  capabilities: string[];
  displayName?: string;
  label?: string;
  /** provide() 时声明的 priority 数值；越大越优先 */
  priority: number;
}

export interface ServiceInfo {
  providers: ServiceProviderInfo[];
  /** 当前生效的偏好 contextId（无偏好则为 null）；preferred > priority */
  preferred: string | null;
}

export type PageTab = string;

export interface ToolGroupDetail {
  name: string;
  label: string;
  description?: string;
  /** 注册该分组的插件（owner，可能与下方贡献插件不同） */
  pluginName: string;
  toolCount: number;
  /** 该分组下所有工具的来源插件去重列表 */
  contributingPlugins?: string[];
}

// ----- 声明式页面类型 (镜像 core) -----

export interface WebuiStatComponent { type: 'stat'; label: string; source: string; icon?: string }
export interface WebuiTableComponent { type: 'table'; label?: string; source: string; columns: Array<{ key: string; label: string; render?: string; nowrap?: boolean; minWidth?: number; maxWidth?: number }>; actions?: Array<{ label: string; method: string; confirm?: string; danger?: boolean }>; refresh?: number; searchable?: boolean; searchPlaceholder?: string }
export interface WebuiFormComponent { type: 'form'; label?: string; source: string; save: string; schema: ConfigSchema }
export interface WebuiActionsComponent { type: 'actions'; label?: string; items: Array<{ label: string; method: string; confirm?: string; danger?: boolean; variant?: string }> }
export interface WebuiInfoComponent { type: 'info'; label?: string; source: string }
export interface WebuiMarkdownComponent { type: 'markdown'; label?: string; source: string }
export interface WebuiTabsComponent { type: 'tabs'; label?: string; items: Array<{ key: string; label: string; content: WebuiComponent[] }> }
export interface WebuiGraphComponent {
  type: 'graph';
  label?: string;
  source: string;
  detailSource?: string;
  defaultMaxDepth?: number;
  defaultMaxBreadth?: number;
  refresh?: number;
  actions?: Array<{ label: string; method: string; confirm?: string; danger?: boolean; variant?: string }>;
}
export type WebuiComponent = WebuiStatComponent | WebuiTableComponent | WebuiFormComponent | WebuiActionsComponent | WebuiInfoComponent | WebuiMarkdownComponent | WebuiTabsComponent | WebuiGraphComponent;

export interface WebuiPageDef {
  key: string;
  label: string;
  icon?: string;
  order?: number;
  plugin: string;
  pluginDisplayName?: string;
  renderer?: string;
  content?: WebuiComponent[];
}

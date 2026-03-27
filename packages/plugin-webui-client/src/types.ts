// ===== 共享类型 =====

export type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; result?: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoningContent?: string;
  segments?: ContentSegment[];
  /** 思考阶段的 segments（文本与工具调用交替） */
  reasoningSegments?: ContentSegment[];
  /** 附带的图片（base64 data URL）*/
  images?: string[];
  /** 附带的文件名列表（仅用于显示） */
  fileNames?: string[];
  timestamp: number;
}

export interface LogEntry {
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
  asTools?: boolean;
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
  state: string;
  provides: string[];
  core: boolean;
  extends?: ExtendDeclaration;
  config: Record<string, unknown>;
  configSchema?: ConfigSchema;
  defaultConfig?: Record<string, unknown>;
  error?: string;
}

// ----- ConfigSchema 类型 (镜像 core) -----

export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect';

export interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  secret?: boolean;
  options?: Array<{ label: string; value: string | number }>;
  dynamicOptions?: string;
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
}

export interface ServiceInfo {
  providers: ServiceProviderInfo[];
  active: string | undefined;
}

export type PageTab = string;

export interface ToolGroupDetail {
  name: string;
  label: string;
  description?: string;
  pluginName: string;
  toolCount: number;
}

// ----- 声明式页面类型 (镜像 core) -----

export interface WebuiStatComponent { type: 'stat'; label: string; source: string; icon?: string }
export interface WebuiTableComponent { type: 'table'; label?: string; source: string; columns: Array<{ key: string; label: string; render?: string }>; actions?: Array<{ label: string; method: string; confirm?: string; danger?: boolean }>; refresh?: number }
export interface WebuiFormComponent { type: 'form'; label?: string; source: string; save: string; schema: ConfigSchema }
export interface WebuiActionsComponent { type: 'actions'; label?: string; items: Array<{ label: string; method: string; confirm?: string; danger?: boolean; variant?: string }> }
export interface WebuiInfoComponent { type: 'info'; label?: string; source: string }
export interface WebuiMarkdownComponent { type: 'markdown'; label?: string; source: string }
export interface WebuiTabsComponent { type: 'tabs'; label?: string; items: Array<{ key: string; label: string; content: WebuiComponent[] }> }
export type WebuiComponent = WebuiStatComponent | WebuiTableComponent | WebuiFormComponent | WebuiActionsComponent | WebuiInfoComponent | WebuiMarkdownComponent | WebuiTabsComponent;

export interface WebuiPageDef {
  key: string;
  label: string;
  icon?: string;
  order?: number;
  plugin: string;
  content?: WebuiComponent[];
}

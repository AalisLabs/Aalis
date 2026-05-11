// ===== 核心机制类型 =====

// ----- 安全与权限 -----

/** 安全等级：safe=安全操作, dangerous=高危操作 */
export type SafetyLevel = 'safe' | 'dangerous';

/** 细粒度权限标识，如 tool:file.write、storage:workspace:read */
export type PermissionId = string;

/** 用户身份标识 */
export interface UserIdentity {
  platform: string;
  userId: string;
}

// ----- 消息 -----

/**
 * 内容时间线分段（按到达顺序记录助手输出的真实结构）。
 * - text：正常对话文本
 * - reasoning_text：思考/推理文本（部分模型如 DeepSeek-R1、Ollama thinking 会产出）
 * - tool_call：工具调用片段（startTime/endTime 用于时长展示）
 *
 * 该数组若存在则为渲染顺序的真相；同时 message.content / reasoningContent
 * 仍保留为派生镜像，供 LLM API 与历史压缩等纯文本消费者使用。
 */
export type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'reasoning_text'; content: string }
  | {
      type: 'tool_call';
      name: string;
      args: Record<string, unknown>;
      result?: string;
      startTime?: number;
      endTime?: number;
    };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  timestamp?: number;
  reasoningContent?: string | null;
  /**
   * 助手输出的有序时间线（含 text / reasoning_text / tool_call）。
   * 仅 assistant 消息可能携带；存在时为 UI 渲染的权威来源，
   * content 与 reasoningContent 应与之保持一致（由生产方在累积时同步写）。
   */
  segments?: ContentSegment[];
  /** 图片列表（base64 data URL 或 HTTP URL），用于多模态 LLM */
  images?: string[];
  /** 元数据：用于标记消息来源等信息（不会发送给 LLM） */
  metadata?: Record<string, unknown>;
}

// 注：IncomingMessage / OutgoingMessage / StreamChunkMessage 已迁出到 @aalis/plugin-message-api（cleanup-8）
// 注：ToolCallContext / ToolExecuteMessage 已迁出到 @aalis/plugin-tools-api（cleanup-8）

// ----- 工具调用 (DeepSeek/OpenAI format) -----

export interface ToolFunction {
  name: string;
  strict?: boolean;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// 注：ToolCallContext 已迁出到 @aalis/plugin-tools-api（cleanup-8，平台语义而非 OpenAI 协议）
// 注：RegisteredTool / ToolSummary / ToolGroupInfo 已迁出到 @aalis/plugin-tools-api（cleanup-6）
// 注：CommandContext / CommandDefinition / SubcommandDefinition / RegisteredCommand 等已迁出到 @aalis/plugin-commands-api（cleanup-6）

// ----- 服务依赖声明 -----

export interface ServiceDependency {
  service: string;
  capabilities?: string[];
}

export type DependencyDeclaration = string | ServiceDependency;

export interface InjectDeclaration {
  required?: DependencyDeclaration[];
  optional?: DependencyDeclaration[];
}

// ----- 插件扩展声明 -----

/**
 * 插件可以声明它对 core 做了哪些扩展，用于前端展示和文档生成。
 *
 * @example
 * export const extends_: ExtendDeclaration = {
 *   events: ['scheduler:tick', 'scheduler:error'],
 *   hooks: ['schedule:before'],
 *   mixins: { scheduler: ['schedule', 'cron'] },
 * };
 */
export interface ExtendDeclaration {
  /** 该插件新增的自定义事件名 */
  events?: string[];
  /** 该插件新增的自定义钩子名 */
  hooks?: string[];
  /** 该插件 mixin 到 Context 上的方法: { 服务名: [方法名...] } */
  mixins?: Record<string, string[]>;
}

// ----- 配置 Schema  -----

export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect' | 'textarea';

export interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  /** 标记为敏感字段，前端显示时自动遮蔽 */
  secret?: boolean;
  /** select / multiselect 类型的静态选项 */
  options?: Array<{ label: string; value: string | number }>;
  /** select / multiselect 类型的动态选项来源：填服务名 (如 'llm', 'embedding', 'platform')，
   *  运行时调用 service.listModels() 获取（platform 特殊处理：收集所有 adapter.platform） */
  dynamicOptions?: string;
  /** select 类型的动态选项来源：填服务名 (如 'llm')，
   *  运行时获取该服务的所有提供者列表（contextId + displayName） */
  dynamicProviders?: string;
  /** multiselect 是否允许用户手动输入自定义值（不限于选项列表） */
  allowCustom?: boolean;
}

export interface SchemaGroup {
  label?: string;
  description?: string;
  fields: Record<string, SchemaField>;
}

/** 数组 Schema：对象数组，每个元素用 items 描述其字段结构 */
export interface SchemaArray {
  type: 'array';
  label: string;
  description?: string;
  /** 数组每个元素的字段定义 */
  items: Record<string, SchemaField>;
  default?: unknown[];
}

/** 配置 Schema：顶层 key 可以是字段、分组或数组 */
export type ConfigSchema = Record<string, SchemaField | SchemaGroup | SchemaArray>;

// ----- 事件类型 -----

/**
 * 内置事件表
 *
 * 第三方插件可通过 TypeScript declaration merging 扩展：
 * ```ts
 * declare module '@aalis/core' {
 *   interface AalisEvents {
 *     'scheduler:tick': [jobId: string];
 *   }
 * }
 * ```
 */
export interface AalisEvents {
  // 业务消息事件（inbound:message / inbound:message:archived / outbound:message / outbound:stream）
  // 已通过 declaration merging 由 @aalis/plugin-message-api 注入（cleanup-8）。
  // 业务工具事件（tool:execute）已通过 declaration merging 由 @aalis/plugin-tools-api 注入（cleanup-8）。
  // gateway:phase:done 由 @aalis/plugin-gateway-api 注入（cleanup-7）。
  'service:registered': [name: string, capabilities: string[]];
  'service:unregistered': [name: string];
  'plugin:loaded': [name: string];
  'plugin:unloaded': [name: string];
  'plugins:changed': [];
  ready: [];
  /** 应用已启动完成，适合 CLI / TUI 等用户交互入口接管终端 */
  'app:started': [];
  dispose: [];
  restarting: [];
  /** 应用正在启动（start() 开头，在服务检查和消息路由注册之前） */
  'app:starting': [];
  /** 应用正在停止（stop() 开头，在 dispose 之前） */
  'app:stopping': [];
  // 允许任意字符串 key 兜底（运行时事件总线开放，但鼓励第三方插件通过 declaration merging 显式声明事件签名以获得类型安全）
  [key: string]: unknown[];
}

// ----- 钩子/中间件类型 -----

/**
 * 中间件 next 函数，调用它将控制传递给下一个中间件或默认行为
 */
export type MiddlewareNext = () => Promise<void>;

/**
 * 中间件函数签名：接收数据和 next，可选择修改数据或中断流程
 */
export type MiddlewareFn<T> = (data: T, next: MiddlewareNext) => Promise<void>;

// 注：指令系统类型（CommandContext / CommandValueType / CommandArgumentDefinition /
// CommandOptionDefinition / CommandDefinition / SubcommandDefinition / RegisteredCommand）
// 已迁出到 @aalis/plugin-commands-api（cleanup-6）

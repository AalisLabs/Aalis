// ===== 核心机制类型 =====

// 注：SafetyLevel / PermissionId 已迁出到 @aalis/plugin-authority-api（权限词汇归位）

// 注：Message / ContentSegment 已迁出到 @aalis/plugin-agent-api（cleanup-N，core 纯通用 IoC 化）
// 注：ToolCall / ToolDefinition / ToolFunction 已迁出到 @aalis/plugin-tools-api（cleanup-N）
// 注：IncomingMessage / OutgoingMessage / StreamChunkMessage 已迁出到 @aalis/plugin-message-api（cleanup-8）
// 注：ToolCallContext / ToolExecuteMessage 已迁出到 @aalis/plugin-tools-api（cleanup-8）
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

// ----- 配置 Schema  -----

export type SchemaFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'textarea'
  /** LLM 模型引用：值形如 `{ provider: string; model: string }`，由前端渲染为联动 select
   *  （provider 列表来自 `/api/models/llm` 的 contextId 聚合；model 列表由所选 provider 决定）。
   *  core 不解释此字段，仅作为 schema 标签；运行时由消费方使用 `resolveLLMModel(ctx, value, caps)` 解析。 */
  | 'llm-ref';

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
  /** select / multiselect 动态选项来源：服务名（消费方实现自己的 dynamicOptions 解析器，
   *  通常约定为运行时调用该服务的 listModels() 或等价方法）。core 不解释此字段语义，
   *  仅作为透传 hint 给前端/解析器。 */
  dynamicOptions?: string;
  /** select 动态选项来源：服务名（解析为该服务的所有提供者列表 contextId + displayName）。
   *  与 dynamicOptions 一样，core 不解释，由消费方实现。 */
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
  /**
   * 某服务的偏好 provider 发生切换（preferService / unpreferService）。
   * 偏好切换会改变 getService(name) 的胜者但不改变 entry 集合，
   * 因此不能复用 registered/unregistered 语义；whenService 借此事件跟随重挂。
   */
  'service:preference-changed': [name: string];
  'plugin:loaded': [name: string];
  'plugin:unloaded': [name: string];
  'plugins:changed': [];
  ready: [];
  /** 应用已启动完成，适合 CLI / TUI 等用户交互入口接管终端 */
  'app:started': [];
  restarting: [];
  /** 应用正在启动（start() 开头，在服务检查和消息路由注册之前） */
  'app:starting': [];
  /**
   * 应用正在停止（stop() 开头，在插件拓扑逆序 dispose 之前）。
   *
   * ⚠． 插件内部清理副作用（关连接、停计时器、flush 缓冲区等）请用
   *    `ctx.onDispose(cb)` 而不是订阅任何事件。事件只在 app 全局停机
   *    时触发一次，**不会**在插件 bounce / unload / updatePluginConfig 等
   *    增量重载路径上触发——会造成资源泄漏（旧 ws/db 连接未关闭等）。
   */
  'app:stopping': [];
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

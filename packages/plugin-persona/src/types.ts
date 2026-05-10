// ----- 人格服务接口 -----
// 由 @aalis/plugin-persona 拥有并导出。消费者从本包 import type。

/** 输出格式中单个字段的定义 */
export interface OutputFormatField {
  /** 字段用途描述（写入 system prompt 供 LLM 理解） */
  description: string;
  /** 字段类型（影响 system prompt 占位符和输出后的类型强制） */
  type?: 'string' | 'number' | 'boolean';
  /** 是否为发送给用户的回复字段（有且仅有一个） */
  reply?: boolean;
}

/** 角色卡定义的结构化输出格式 */
export interface OutputFormat {
  /** 字段定义表：key = JSON 字段名 */
  fields: Record<string, OutputFormatField>;
  /** 回复字段名（自动推断，取 reply: true 的那个 key） */
  replyField: string;
}

/**
 * 会话级选项，由调用方（如 agent-default）从 SessionConfig 构造后传入。
 * PersonaService 本身不关心 session-manager，只根据传入的选项调整行为。
 */
export interface PersonaSessionOptions {
  /** 覆盖角色卡名称 */
  persona?: string;
  /** 禁用结构化输出格式 */
  disableOutputFormat?: boolean;
  /** 客户端渲染 JSON 覆盖 */
  clientSideJsonRendering?: boolean;
}

export interface PersonaService {
  getSystemPrompt(options?: PersonaSessionOptions): string;
  getPersonaName(): string;
  /** 获取角色卡定义的结构化输出格式，无定义时返回 undefined */
  getOutputFormat?(options?: PersonaSessionOptions): OutputFormat | undefined;
  /** 该角色卡是否配置为客户端渲染 JSON */
  isClientSideJsonRendering?(options?: PersonaSessionOptions): boolean;
  /** 列出可用的人设卡（用于前端下拉框） */
  listModels?(): Promise<string[]>;
  /** 获取角色卡定义的昵称列表（用于触发检测） */
  getNickNames?(): string[];
  /** 获取角色卡定义的禁言关键词列表 */
  getMuteKeywords?(): string[];
  /** 是否启用了时间注入（供其他插件判断是否需要注册时间相关工具） */
  isTimeInjectionEnabled?(): boolean;
}

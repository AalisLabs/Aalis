// ----- 人格服务接口 -----

/** 输出格式中单个字段的定义 */
export interface OutputFormatField {
  /** 字段用途描述（写入 system prompt 供 LLM 理解） */
  description: string;
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

export interface PersonaService {
  getSystemPrompt(): string;
  getPersonaName(): string;
  /** 获取角色卡定义的结构化输出格式，无定义时返回 undefined */
  getOutputFormat?(): OutputFormat | undefined;
  /** 列出可用的人设卡（用于前端下拉框） */
  listModels?(): Promise<string[]>;
  /** 获取角色卡定义的昵称列表（用于触发检测） */
  getNickNames?(): string[];
  /** 获取角色卡定义的禁言关键词列表 */
  getMuteKeywords?(): string[];
}

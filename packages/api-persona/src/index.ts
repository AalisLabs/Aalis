// ----- 人格服务接口 -----
// 由 @aalis/plugin-persona 拥有并导出。消费者从本包 import type。

import { defineService } from '@aalis/core';

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
  /**
   * 格式校验失败时允许的最大重试次数（额外向 LLM 请求的次数，不含首次）。
   * 缺省为 1。设为 0 时不重试，第一次失败即静默丢弃。
   */
  retries: number;
}

/**
 * 按会话取设置的选项：人设服务按这个会话（platform 是入口平台，只对没有出生平台的会话起作用）读自己的会话设置（人设、额外
 * 提示、结构化输出的两个开关）。不给 sessionId 时按人设插件的配置
 */
export interface PersonaSessionOptions {
  sessionId?: string;
  platform?: string;
}

export interface PersonaService {
  /**
   * 静态人设：人设卡、行为准则、输出格式。**同一张卡下逐轮不变**。
   *
   * 与 {@link getVolatilePrompt} 的切分是为前缀缓存服务：LLM provider 的前缀缓存
   * 从第一个 token 起逐位比对，只要开头有一处变化，后面整条前缀全部作废。把每轮
   * 都变的内容（时间、会话环境、上轮状态）留在这里，会让人设卡 + 历史这几万 token
   * 一次都命中不了——实测 91% 的首轮调用命中率为 0。
   */
  getSystemPrompt(options?: PersonaSessionOptions): string;
  /**
   * 易变上下文：当前时间、会话环境、上一轮状态。**逐轮变化**。
   *
   * 调用方应把它放在历史消息**之后**、当前用户消息之前——这样前面的静态部分才进得了
   * 缓存。语义上也更顺：这些本就是「此刻的事实」，紧挨当前消息说比夹在人设卡里自然。
   * 无内容时返回空串，调用方据此跳过。
   */
  getVolatilePrompt?(options?: PersonaSessionOptions): string;
  /**
   * 角色卡的名字：按 options 这个会话的「人设」取卡（找不到该卡时与其它方法一样回落主卡）。触发插件按会话取它做点名识别，
   * 终端按自己的会话取它作署名。卡没取名时返回空串，不给兜底的名字：要显示名字的一方自己兜底，点名识别跳过空串。
   */
  getPersonaName(options?: PersonaSessionOptions): string;
  /** 获取角色卡定义的结构化输出格式，无定义时返回 undefined */
  getOutputFormat?(options?: PersonaSessionOptions): OutputFormat | undefined;
  /** 该角色卡是否配置为客户端渲染 JSON */
  isClientSideJsonRendering?(options?: PersonaSessionOptions): boolean;
  /** 列出可用的人设卡（用于前端下拉框） */
  listModels?(): Promise<string[]>;
  /** 获取角色卡定义的昵称列表（用于触发检测）；按 options 取卡，同 getPersonaName */
  getNickNames?(options?: PersonaSessionOptions): string[];
  /** 是否启用了时间注入（供其他插件判断是否需要注册时间相关工具） */
  isTimeInjectionEnabled?(): boolean;
}

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
export const persona = defineService<PersonaService>('persona');

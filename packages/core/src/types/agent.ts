// ----- Agent 服务接口 -----

import type { IncomingMessage, PluginGroupInfo } from './core.js';

/**
 * 消息预处理器函数
 *
 * 在消息到达 LLM 之前对 IncomingMessage 进行变换。
 * 遵循洋葱模型：调用 `next()` 将控制权传递给下一个预处理器，
 * 不调用则中断整个流程（LLM 不会被调用）。
 */
export type PreprocessorFn = (
  message: IncomingMessage,
  next: () => Promise<void>,
) => Promise<void>;

/** 已注册预处理器的元信息 */
export interface PreprocessorInfo {
  /** 预处理器名称 */
  name: string;
}

/**
 * Agent 服务 —— 对话编排引擎
 *
 * 负责接收用户消息并编排完整的对话流程：
 * 组装系统提示、加载历史、调用 LLM、执行工具调用循环、发出回复。
 *
 * 默认由 plugin-agent-default 提供。
 * 外部插件可以注册自己的 AgentService 来完全接管或扩展对话编排逻辑。
 */
export interface AgentService {
  /** 处理一条传入消息，完成完整的对话循环 */
  handleMessage(message: IncomingMessage): Promise<void>;
  /** 中止指定会话的当前生成（可选实现） */
  abort?(sessionId: string): void;

  /**
   * 注册消息预处理器
   *
   * 预处理器在 `agent:input:before` 阶段运行，可以修改 IncomingMessage（如将图片转文字、解析文件）。
   * 底层通过中间件系统实现，priority 越大越先执行。
   *
   * @param name 预处理器名称（用于日志和调试）
   * @param handler 处理函数
   * @param priority 优先级（默认 500，越大越先执行）
   * @returns dispose 函数，调用后注销此预处理器
   */
  registerPreprocessor?(name: string, handler: PreprocessorFn): () => void;

  /** 获取当前所有已注册预处理器的元信息 */
  getPreprocessors?(): PreprocessorInfo[];

  /**
   * 获取 Agent 子系统的插件分组
   *
   * 基于 Agent 的 inject 声明，自动找出所有为 Agent 提供服务的插件，
   * 返回分组信息供 Dashboard 使用。
   */
  getPluginGroups?(): PluginGroupInfo[];
}

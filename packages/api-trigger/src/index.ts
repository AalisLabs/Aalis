// ============================================================
// @aalis/api-trigger — 触发判定契约（"要不要开口"）
//
// 'trigger' 是多提供者服务。相位宿主（plugin-trigger-policy，占据 inbound:trigger）负责
// 作用域、禁言关键词、计数与闲置等公共部分，再把"这条消息要不要开口"逐个问提供者：
// 按 trigger.all() 的顺序（偏好 > 优先级 > 注册顺序），第一个不弃权的提供者说了算。
// 宿主自带规则提供者（计数/评分/点名，优先级 0），它不弃权，是兜底；模型提供者以更高
// 优先级登记，未就绪、超时或处于影子模式时弃权，交给后面的提供者。
//
// 提供者只判定、不写状态：开口后的计数清零、triggerType 与授权主体由宿主统一写。
//
// 服务名：'trigger'
// ============================================================

import { defineService } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';

/** 宿主交给提供者的一次判定输入 */
export interface TriggerInput {
  /** 当前入站消息。只读：triggerType、授权主体等由宿主在判定之后统一写 */
  message: Readonly<IncomingMessage>;
  /**
   * 宿主识别的"被点名"：@ 自己、戳一戳、名字或别名命中（按宿主配置 triggerOnAt / triggerOnPoke /
   * triggerNames 与人设名字）。规则提供者据此直接开口；模型提供者只把它当类别信息。
   * 无论谁开口，宿主都按它定开口后的类别：点名为 immediate，否则为 interval。
   */
  addressed: boolean;
  /**
   * 需要附件描述时调用：宿主按需启动附件识别并等待，写好 message._attachmentDescriptions。
   * 等待有上限，超时照常返回（识别在后台继续，描述可能仍缺），永不抛错；多次调用共享同一次识别。
   * 等待的时间不计入宿主给本次判定的截止时间。不需要附件描述的提供者不要调用，免得拖慢判定。
   */
  awaitAttachmentDescriptions(): Promise<void>;
}

/** 一次判定结果 */
export interface TriggerDecision {
  /** 是否开口 */
  speak: boolean;
  /** 判定依据的简短说明，进宿主的判定日志；不要放消息原文 */
  reason: string;
  /** 可选的分数（如模型 logit），进宿主的判定日志 */
  score?: number;
}

export interface TriggerProvider {
  /**
   * 判定这条消息要不要开口。返回 null 表示弃权，宿主转问下一个提供者；抛错或超过宿主的
   * 截止时间都按弃权处理。仅供相位宿主调用：调用前宿主已记好这条入站（计数、评分），
   * 提供者只读不写。
   */
  decide(input: TriggerInput): Promise<TriggerDecision | null>;
}

export const trigger = defineService<TriggerProvider>('trigger');

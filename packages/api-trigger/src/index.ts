// ============================================================
// @aalis/api-trigger — 触发判定契约（"要不要开口"）
//
// 'trigger' 服务标记当前生效的触发插件。触发插件（plugin-trigger-policy 的规则判定、
// plugin-trigger-laya 的模型判定）各自是完整的判定：各自 provide 一个实例，各自在
// inbound:trigger 相位挂中间件。服务胜者（偏好 > 优先级 > 注册顺序）即生效者，二选一：
// 其余触发插件对每条消息直接放行，什么都不做。一个都不在时这个相位不做判定，消息照常往下走。
//
// 本包另含触发插件共用的函数：生效者判断、禁言关键词、名字表与点名识别、放行收尾与吞掉时的影子归档。
// 模块状态只有 isActiveTrigger 按每次入站记下的胜者（进程内全部副本共用一张表）；createBotNames
// 返回的名字表各自记着告警过的故障，归调用方的激活所有。日志前缀由调用方传入（如 '[laya]'）。
//
// 服务名：'trigger'
// ============================================================

import type { MessageArchiveService } from '@aalis/api-message-archive';
import type { PersonaService } from '@aalis/api-persona';
import { defineService, type Logger, type ServiceSelection } from '@aalis/core';
import type { TextRef } from '@aalis/schema-i18n';
import { AT_SELF_PATTERN, type IncomingMessage, WellKnownNoticeTypes } from '@aalis/schema-message';

/**
 * 触发插件在 trigger 服务里的实例。服务只用来选出生效者：消费方拿选中那一条的 id 与自己的实例 id 比，
 * 不调用方法，所以接口只有名字，进诊断（如 Laya 诊断项报「生效的触发插件是某某」）。WebUI 设置「系统」的
 * 服务偏好显示的是 provide 时传的 label，两处取同一个值。名字可以是文字对象（@aalis/schema-i18n）：要写进句子的
 * 作为文字对象的参数，出口按读者语言渲染
 */
export interface TriggerService {
  readonly label: string | TextRef;
}

export const trigger = defineService<TriggerService>('trigger');

// ----- 生效者 -----

/**
 * 每次入站取下的胜者，以 inbound:trigger 的相位数据对象为键。进程内全部 api-trigger 副本共用一张表（经全局
 * 符号表取同一个对象）：契约包可能装了两份，两个触发插件各用一份时各记各的，同一条消息就可能被两个都判，
 * 或两个都不判
 */
const JUDGED_BY = Symbol.for('@aalis/api-trigger.judgedBy');
const shared = globalThis as Record<symbol, WeakMap<object, string | undefined> | undefined>;
shared[JUDGED_BY] ??= new WeakMap();
const judgedBy = shared[JUDGED_BY];

/**
 * 这次入站是否由 selfId（触发插件登记 trigger 时的条目 id，缺省即它的实例 id）判定。胜者每次入站只取一次：相位里
 * 先跑到的触发插件取下 trigger 选中的那一条的 id，以这次的相位数据为键记在共用的表里，后跑到的沿用它。判定途中切换
 * 偏好、停用或重载触发插件时，同一条消息不会被两个触发插件各判一次。
 * 只在调用的那一刻读选择层，不建立跟随状态
 */
export function isActiveTrigger(
  phase: object,
  ref: Pick<ServiceSelection<TriggerService>, 'list'>,
  selfId: string,
): boolean {
  if (!judgedBy.has(phase)) judgedBy.set(phase, ref.list().find(p => p.selected)?.id);
  return judgedBy.get(phase) === selfId;
}

// ----- 禁言关键词与点名 -----

/**
 * 正文是否包含任一禁言关键词。戳一戳通知恒不命中：它的正文是适配器合成的文案（内嵌戳者昵称），
 * 与名字检测同理不当发言评估。
 */
export function hitsMuteKeyword(
  message: Pick<IncomingMessage, 'content' | 'noticeType'>,
  keywords: readonly string[],
): boolean {
  if (message.noticeType === WellKnownNoticeTypes.Poke) return false;
  return keywords.some(kw => message.content.includes(kw));
}

/** 点名识别的开关（触发插件的配置里都有这两项；名字表由 createBotNames 取） */
export interface AddressOptions {
  /** @ 自己算点名 */
  triggerOnAt: boolean;
  /** 指向机器人的戳一戳等注意力动作（noticeType=poke）算点名 */
  triggerOnPoke: boolean;
}

/**
 * 建一个名字表：每次调用按这条消息的会话现取，返回别名（triggerNames）与这个会话在用的人设的名字、昵称的并集，
 * 去重、去空，别名在前。触发插件激活时建一个，点名识别与 Laya 发给侧车的 selfNames 用同一份。
 *
 * 在用的人设是人设服务此刻的胜者（`persona.use`，按触发插件自己的服务偏好选出）：同时装了多个人设插件时，只有它的名字、
 * 昵称算点名；给 agent 单设了人设偏好时，触发插件要设同一个。人设按会话取，与 agent 同一取法：这条消息的会话与入口平台
 * （`{ sessionId, platform }`）交给它的 getPersonaName / getNickNames，由人设服务按这个会话的「人设」取卡。会话改用别的角色卡时，
 * 那张卡的名字、昵称算点名，主卡的不算。
 *
 * 读名字抛错时名字表只剩别名，照常判定：记一条 warn，同一原因只记一次（读成功一次后再出错会再记）。禁言关键词不从 persona 读：
 * 避免角色卡措辞成为禁言开关，也避免进程级单例 persona 跨平台泄漏。
 */
export function createBotNames(
  persona: Pick<ServiceSelection<PersonaService>, 'present' | 'use'>,
  logger: Logger,
  tag: string,
): (triggerNames: readonly string[], message: Pick<IncomingMessage, 'sessionId' | 'platform'>) => string[] {
  /** 读名字失败时已告警的原因；undefined = 上次读成功 */
  let failure: string | undefined;

  return (triggerNames, message) => {
    const names = new Set<string>();
    const add = (n: unknown) => {
      if (typeof n === 'string' && n) names.add(n);
    };
    for (const n of triggerNames) add(n);
    if (persona.present) {
      const options = { sessionId: message.sessionId, platform: message.platform };
      try {
        const own = [persona.use.getPersonaName(options), ...(persona.use.getNickNames?.(options) ?? [])];
        failure = undefined;
        for (const n of own) add(n);
      } catch (err) {
        const reason = `${err}`;
        if (failure !== reason) {
          failure = reason;
          logger.warn(`${tag} 人设读名字失败，点名识别只用别名: ${reason}`);
        }
      }
    }
    return [...names];
  };
}

/**
 * 是否被点名。戳一戳按适配器标记的目标与 triggerOnPoke 判定，**不做** @ 与名字检测：它的正文是合成文案，内嵌戳者昵称，昵称含
 * bot 名会被名字检测误判成提及——关掉 triggerOnPoke 后用户改个名就能让开关对自己失效。
 * 其余消息看 triggerOnAt 的 @ 自己（正文里任一处的 AT_SELF_PATTERN 标记：OneBot 的 CQ 码已由适配器入站规范化成它，
 * 别的平台适配器要支持 @ 判定，同样写这个标记），以及名字检测（names 里任一个出现在正文里即命中，names 通常取自 createBotNames）。
 */
export function isAddressed(
  message: Pick<IncomingMessage, 'content' | 'noticeType' | 'noticeTargetIsSelf'>,
  names: readonly string[],
  opts: AddressOptions,
): boolean {
  if (message.noticeType === WellKnownNoticeTypes.Poke)
    return opts.triggerOnPoke && message.noticeTargetIsSelf !== false;
  if (opts.triggerOnAt && AT_SELF_PATTERN.test(message.content)) return true;
  return names.some(name => name && message.content.includes(name));
}

// ----- 放行与吞掉 -----

/**
 * 放行收尾：写 triggerType，点名为 immediate，否则为 interval。点名只决定她回不回与触发类型，不动授权身份：被频率触发挑中的
 * 那句话照旧按说它的人算
 */
export function markTriggered(message: IncomingMessage, addressed: boolean): void {
  message.triggerType = addressed ? 'immediate' : 'interval';
}

/** 吞掉前把消息影子归档（与 flow-control 吞掉时的归档对齐）。message-archive 缺席时跳过，归档失败记 warn，不抛错 */
export async function archiveSwallowed(
  message: IncomingMessage,
  archive: Pick<ServiceSelection<MessageArchiveService>, 'present' | 'use'>,
  logger: Logger,
  tag: string,
): Promise<void> {
  if (!archive.present) return;
  try {
    await archive.use.archiveIncoming(message);
  } catch (err) {
    logger.warn(`${tag} shadow 归档失败: ${err}`);
  }
}

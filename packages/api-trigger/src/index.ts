// ============================================================
// @aalis/api-trigger — 触发判定契约（"要不要开口"）
//
// 'trigger' 服务标记当前生效的触发插件。触发插件（plugin-trigger-policy 的规则判定、
// plugin-trigger-laya 的模型判定）各自是完整的判定：各自 provide 一个实例，各自在
// inbound:trigger 相位挂中间件。服务胜者（偏好 > 优先级 > 注册顺序）即生效者，二选一：
// 其余触发插件对每条消息直接放行，什么都不做。一个都不在时这个相位不做判定，消息照常往下走。
//
// 本包另含触发插件共用的宿主函数：生效者判断、禁言关键词、名字表与点名识别、附件识别限时等待、
// 放行收尾与吞掉时的影子归档。模块状态只有 isActiveTrigger 按每次入站记下的胜者；createBotNames
// 返回的名字表各自记着告警过的故障，归调用方的激活所有。日志前缀由调用方传入（如 '[laya]'）。
//
// 服务名：'trigger'
// ============================================================

import type { MediaService } from '@aalis/api-media';
import type { MessageArchiveService } from '@aalis/api-message-archive';
import type { PersonaService, PersonaSessionOptions } from '@aalis/api-persona';
import type { SessionManagerService } from '@aalis/api-session-manager';
import { defineService, type Logger, type ServiceRef } from '@aalis/core';
import { type IncomingMessage, selfInitiatedActor, WellKnownNoticeTypes } from '@aalis/schema-message';

/**
 * 触发插件在 trigger 服务里的实例。服务只用来选出生效者：消费方拿胜者与自己的实例比身份，
 * 不调用方法，所以接口只有名字，进诊断（如 Laya 诊断项报「生效的触发插件是某某」）。WebUI 服务页
 * 显示的是 provide 时传的 label，两处取同一个值。
 */
export interface TriggerService {
  readonly label: string;
}

export const trigger = defineService<TriggerService>('trigger');

/** 只读当前胜者的那一面：这里的函数只在调用的那一刻读 current，不建立跟随状态 */
type CurrentOf<P> = Pick<ServiceRef<P>, 'current'>;
/** 只读全部提供者的那一面，同样只在调用的那一刻枚举 */
type AllOf<P> = Pick<ServiceRef<P>, 'all'>;

// ----- 生效者 -----

/** 每次入站取下的胜者，以 inbound:trigger 的相位数据对象为键 */
const judgedBy = new WeakMap<object, TriggerService | undefined>();

/**
 * 这次入站是否由 self 判定。胜者每次入站只取一次：相位里先跑到的触发插件取下 trigger.current，
 * 以这次的相位数据为键记在本模块的表里，后跑到的沿用它。判定途中切换偏好、停用或重载触发插件时，
 * 同一条消息不会被两个触发插件各判一次。
 */
export function isActiveTrigger(phase: object, ref: CurrentOf<TriggerService>, self: TriggerService): boolean {
  if (!judgedBy.has(phase)) judgedBy.set(phase, ref.current);
  return judgedBy.get(phase) === self;
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
  /** 戳一戳等注意力动作（noticeType=poke）算点名 */
  triggerOnPoke: boolean;
}

/**
 * @ 检测：只认 `<at self>` 标记。
 *
 * OneBot 的字符串消息格式（含 `[CQ:at,…]`）由 adapter 入站规范化成消息段，再经
 * segmentsToText 渲染成 `<at self id="…">`，CQ 码不会流到这里。其它平台适配器若要支持
 * @ 判定，须同样把提及渲染成 `<at self …>`——这里只认这一种文法。
 */
function mentionsSelf(content: string): boolean {
  return /<at self[\s>][\s\S]*?<\/at>/.test(content);
}

/**
 * 建一个名字表：每次调用按这条消息的会话现取，返回别名（triggerNames）与全部已登记人设的名字、昵称的并集，
 * 去重、去空，别名在前、人设按服务解析顺序在后。触发插件激活时建一个，点名识别与 Laya 发给侧车的 selfNames
 * 用同一份。
 *
 * 人设按会话取，与 agent 同一取法：session-manager 解析这个会话的配置（resolveConfig(sessionId, platform)），
 * 其中的 persona（会话用的角色卡）传给每个人设提供者的 getPersonaName / getNickNames。会话改用别的角色卡时，
 * 那张卡的名字、昵称算点名，主卡的不算。session-manager 缺席时不带参数取（全局默认的卡）；解析抛错时同样
 * 不带参数取，记一条 warn，同一原因只记一次（解析成功一次后再出错会再记）。
 *
 * 取全部人设提供者（persona.all()）而不只取当前胜者：同时装了多个人设插件时，叫其中任何一个的名字都算点名。
 * 某个人设提供者读名字抛错时只跳过它的名字，其余照常：记一条 warn，同一提供者同一原因只记一次（它读成功一次后
 * 再出错会再记）。禁言关键词不从 persona 读：避免角色卡措辞成为禁言开关，也避免进程级单例 persona 跨平台泄漏。
 */
export function createBotNames(
  persona: AllOf<PersonaService>,
  sessionManager: CurrentOf<SessionManagerService>,
  logger: Logger,
  tag: string,
): (triggerNames: readonly string[], message: Pick<IncomingMessage, 'sessionId' | 'platform'>) => string[] {
  /** 正在出错的提供者 → 已告警的原因 */
  const failing = new WeakMap<PersonaService, string>();
  /** session-manager 解析会话配置时已告警的原因；undefined = 上次解析成功 */
  let resolveFailure: string | undefined;

  /** 这个会话的人设选项；session-manager 缺席或解析抛错时为 undefined（全局默认的卡） */
  function sessionOptions(message: Pick<IncomingMessage, 'sessionId' | 'platform'>): PersonaSessionOptions | undefined {
    const sm = sessionManager.current;
    if (!sm) return undefined;
    try {
      const options = { persona: sm.resolveConfig(message.sessionId, message.platform).persona };
      resolveFailure = undefined;
      return options;
    } catch (err) {
      const reason = `${err}`;
      if (resolveFailure !== reason) {
        resolveFailure = reason;
        logger.warn(`${tag} 解析会话配置失败，名字表按全局默认的人设取: ${reason}`);
      }
      return undefined;
    }
  }

  return (triggerNames, message) => {
    const names = new Set<string>();
    const add = (n: unknown) => {
      if (typeof n === 'string' && n) names.add(n);
    };
    for (const n of triggerNames) add(n);
    const options = sessionOptions(message);
    for (const { instance, contextId, label } of persona.all()) {
      let own: unknown[];
      try {
        own = [instance.getPersonaName(options), ...(instance.getNickNames?.(options) ?? [])];
      } catch (err) {
        const reason = `${err}`;
        if (failing.get(instance) !== reason) {
          failing.set(instance, reason);
          logger.warn(`${tag} 人设「${label ?? contextId}」读名字失败，点名识别跳过它的名字: ${reason}`);
        }
        continue;
      }
      failing.delete(instance);
      for (const n of own) add(n);
    }
    return [...names];
  };
}

/**
 * 是否被点名。戳一戳（能进到这里说明 adapter 已判断过目标是 bot：私聊戳全转入站，群聊戳仅目标是
 * 自己才转）只看 triggerOnPoke，**不做** @ 与名字检测：它的正文是合成文案，内嵌戳者昵称，昵称含
 * bot 名会被名字检测误判成提及——关掉 triggerOnPoke 后用户改个名就能让开关对自己失效（对抗审计
 * 实测）。其余消息看 triggerOnAt 的 @ 自己，以及名字检测（names 里任一个出现在正文里即命中，
 * names 通常取自 createBotNames）。
 */
export function isAddressed(
  message: Pick<IncomingMessage, 'content' | 'noticeType'>,
  names: readonly string[],
  opts: AddressOptions,
): boolean {
  if (message.noticeType === WellKnownNoticeTypes.Poke) return opts.triggerOnPoke;
  if (opts.triggerOnAt && mentionsSelf(message.content)) return true;
  return names.some(name => name && message.content.includes(name));
}

// ----- 附件识别 -----

/**
 * 等这条消息的附件识别写好 `_attachmentDescriptions`，最多 waitMs 毫秒。带附件、尚无描述且 media 在场
 * 才启动识别；超时照常返回（识别在后台继续，描述可能仍缺），识别失败记 warn，永不抛错。
 *
 * 放行与吞掉都不必等识别跑完：agent 预处理器与归档对同一个消息对象调 processMessage，media 按消息
 * 对象记忆命中这次识别（在途则等它），不再识别第二遍。
 */
export async function waitForAttachmentDescriptions(
  message: IncomingMessage,
  media: CurrentOf<MediaService>,
  waitMs: number,
  logger: Logger,
  tag: string,
): Promise<void> {
  const svc = media.current;
  if (!svc || !message.attachments?.length || message._attachmentDescriptions) return;
  const recognition = Promise.resolve()
    .then(() => svc.processMessage(message))
    .then(
      () => undefined,
      err => logger.warn(`${tag} 附件识别失败: ${err}`),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([recognition, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ----- 放行与吞掉 -----

/**
 * 放行收尾：写 triggerType，点名为 immediate，否则为 interval。interval 回合无主发言者，在多人会话
 * 且消息未带 actor 时回填无主体授权身份：不让「恰好撞上判定的那个人」（陌生人或 owner）的等级决定
 * AI 自发行为能调什么工具。immediate 是被点名，点名者就是主体，维持缺省（actor 回退到会话身份）。
 * 私聊可以被配进作用域，私聊里的 interval 只是频率闸，发言者就是唯一主体，不回填。
 */
export function markTriggered(message: IncomingMessage, addressed: boolean): void {
  const kind = addressed ? 'immediate' : 'interval';
  message.triggerType = kind;
  if (kind === 'interval' && message.sessionType !== 'private' && !message.actor) {
    message.actor = selfInitiatedActor(message.platform);
  }
}

/** 吞掉前把消息影子归档（与 flow-control 吞掉时的归档对齐）。message-archive 缺席时跳过，归档失败记 warn，不抛错 */
export async function archiveSwallowed(
  message: IncomingMessage,
  archive: CurrentOf<MessageArchiveService>,
  logger: Logger,
  tag: string,
): Promise<void> {
  const svc = archive.current;
  if (!svc) return;
  try {
    await svc.archiveIncoming(message);
  } catch (err) {
    logger.warn(`${tag} shadow 归档失败: ${err}`);
  }
}

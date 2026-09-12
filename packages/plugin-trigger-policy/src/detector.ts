import type { PersonaService } from '@aalis/api-persona';
import type { Context } from '@aalis/core';
import type { TriggerPolicyConfig } from './config.js';

// PersonaService 仅用于 getBotNames（读取昵称/名字）。mute 关键词统一由 trigger-policy 下发配置，
// 不再从 persona 读取（避免单例 PersonaService 跨平台泄漏）。

/**
 * @ 检测：只认 `<at self>` 标记。
 *
 * OneBot 的字符串消息格式（含 `[CQ:at,…]`）由 adapter 入站规范化成消息段，再经
 * segmentsToText 渲染成 `<at self id="…">`，CQ 码不会流到这里。其它平台适配器若要支持
 * @ 判定，须同样把提及渲染成 `<at self …>`——本函数只认这一种文法。
 */
export function checkImmediateMention(content: string): boolean {
  return /<at self[\s>][\s\S]*?<\/at>/.test(content);
}

export function getBotNames(ctx: Context, cfg: TriggerPolicyConfig): string[] {
  const names = [...cfg.triggerNames];
  const persona = ctx.getService<PersonaService>('persona');
  if (persona) {
    const personaName = persona.getPersonaName?.();
    if (personaName && !names.includes(personaName)) names.push(personaName);
    const nicks = persona.getNickNames?.() ?? [];
    for (const n of nicks) {
      if (n && !names.includes(n)) names.push(n);
    }
  }
  return names;
}

export function checkNameMention(content: string, names: string[]): boolean {
  for (const name of names) {
    if (name && content.includes(name)) return true;
  }
  return false;
}

export function checkImmediateTrigger(ctx: Context, cfg: TriggerPolicyConfig, content: string): boolean {
  if (cfg.triggerOnAt && checkImmediateMention(content)) return true;
  if (checkNameMention(content, getBotNames(ctx, cfg))) return true;
  return false;
}

export function checkMuteKeyword(_ctx: Context, cfg: TriggerPolicyConfig, content: string): boolean {
  for (const kw of cfg.muteKeywords) {
    if (content.includes(kw)) return true;
  }
  return false;
}

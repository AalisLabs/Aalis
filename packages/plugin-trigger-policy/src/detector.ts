import type { Context } from '@aalis/core';
import type { PersonaService } from '@aalis/plugin-persona';
import type { TriggerPolicyConfig } from './config.js';

// PersonaService 仅用于 getBotNames（读取昵称/名字）。mute 关键词统一由 trigger-policy 下发配置，
// 不再从 persona 读取（避免单例 PersonaService 跨平台泄漏）。

/** @ 检测：覆盖 onebot 内联格式（<at>、CQ:at）以及通用 @nickname */
export function checkImmediateMention(content: string): boolean {
  if (/<at self[\s>][\s\S]*?<\/at>/.test(content)) return true;
  if (/\[CQ:at,qq=\d+\]/.test(content)) return true;
  if (/@\S+/.test(content)) return true;
  return false;
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

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Context, PersonaService } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-persona';
export const provides = ['persona'];

// ===== 角色卡格式 =====

interface PersonaCard {
  name: string;
  description: string;
  prompt: string;
  traits?: string[];
  greeting?: string;
}

// ===== 实现 =====

class PersonaServiceImpl implements PersonaService {
  private card: PersonaCard;

  constructor(card: PersonaCard) {
    this.card = card;
  }

  getSystemPrompt(): string {
    let prompt = '';
    if (this.card.name) {
      prompt += `你的名字是 ${this.card.name}。`;
    }
    if (this.card.description) {
      prompt += `${this.card.description}\n\n`;
    }
    if (this.card.traits && this.card.traits.length > 0) {
      prompt += `性格特点: ${this.card.traits.join('、')}\n\n`;
    }
    prompt += this.card.prompt;
    return prompt;
  }

  getPersonaName(): string {
    return this.card.name;
  }
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const personaName = ctx.config.get('persona');
  const configDir = ctx.config.getConfigDir();

  // 查找角色卡文件
  const searchPaths = [
    resolve(configDir, 'personas', `${personaName}.yaml`),
    resolve(configDir, 'personas', `${personaName}.yml`),
    resolve(process.cwd(), 'personas', `${personaName}.yaml`),
    resolve(process.cwd(), 'personas', `${personaName}.yml`),
  ];

  let cardPath: string | undefined;
  for (const p of searchPaths) {
    if (existsSync(p)) {
      cardPath = p;
      break;
    }
  }

  let card: PersonaCard;

  if (cardPath) {
    try {
      const raw = readFileSync(cardPath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown>;
      card = {
        name: (parsed.name as string) ?? personaName,
        description: (parsed.description as string) ?? '',
        prompt: (parsed.prompt as string) ?? '',
        traits: parsed.traits as string[] | undefined,
        greeting: parsed.greeting as string | undefined,
      };
      ctx.logger.info(`已加载角色卡: ${card.name} (${cardPath})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`角色卡文件读取/解析失败 (${cardPath}): ${msg}`);
      card = {
        name: 'Aalis',
        description: '一个友好的 AI 助手',
        prompt: '请友好、专业地与用户交流。',
      };
    }
  } else {
    card = {
      name: 'Aalis',
      description: '一个友好的 AI 助手',
      prompt: '请友好、专业地与用户交流。',
    };
    ctx.logger.info(`未找到角色卡 "${personaName}"，使用默认角色`);
  }

  const service = new PersonaServiceImpl(card);
  ctx.provide('persona', service);
}

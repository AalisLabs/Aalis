import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Context, PersonaService, ConfigSchema, OutputFormat, OutputFormatField } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-persona';
export const provides = ['persona'];

export const configSchema: ConfigSchema = {
  persona: {
    type: 'select',
    label: '人设',
    description: '人设文件名（不含后缀）',
    default: 'default',
    dynamicOptions: 'persona',
  },
  personasDir: {
    type: 'string',
    label: '人设目录',
    description: '存放人设文件的目录路径（相对于项目根目录）',
    default: 'data/personas',
  },
};

export const defaultConfig = {
  persona: 'default',
  personasDir: 'data/personas',
};

// ===== 角色卡格式 =====

interface PersonaCard {
  name: string;
  description: string;
  prompt: string;
  traits?: string[];
  greeting?: string;
  outputFormat?: Record<string, { description: string; reply?: boolean }>;
}

// ===== 实现 =====

class PersonaServiceImpl implements PersonaService {
  private card: PersonaCard;
  private _outputFormat?: OutputFormat;
  private searchDirs: string[];
  private fileName: string;

  constructor(card: PersonaCard, searchDirs: string[], fileName: string) {
    this.card = card;
    this.searchDirs = searchDirs;
    this.fileName = fileName;

    // 解析 outputFormat
    if (card.outputFormat) {
      const fields: Record<string, OutputFormatField> = {};
      let replyField: string | undefined;
      for (const [key, def] of Object.entries(card.outputFormat)) {
        fields[key] = { description: def.description, reply: def.reply };
        if (def.reply) replyField = key;
      }
      if (replyField) {
        this._outputFormat = { fields, replyField };
      }
    }
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

    // 追加结构化输出指令
    if (this._outputFormat) {
      prompt += '\n\n# 输出格式\n';
      prompt += '你必须始终以如下 JSON 格式回复，不要输出 JSON 之外的任何内容：\n';
      prompt += '```json\n{\n';
      const entries = Object.entries(this._outputFormat.fields);
      entries.forEach(([key, field], i) => {
        const comma = i < entries.length - 1 ? ',' : '';
        prompt += `  "${key}": "..."${comma}  // ${field.description}${field.reply ? '（发送给用户的回复）' : ''}\n`;
      });
      prompt += '}\n```\n';
      prompt += '严格遵守此格式。不要在 JSON 外包裹 markdown 代码块标记。直接输出纯 JSON。';
    }

    return prompt;
  }

  getPersonaName(): string {
    return this.card.name || `${this.fileName}，未设置名字`;
  }

  getOutputFormat(): OutputFormat | undefined {
    return this._outputFormat;
  }

  async listModels(): Promise<string[]> {
    const names = new Set<string>();
    for (const dir of this.searchDirs) {
      if (!existsSync(dir)) continue;
      let files: string[];
      try { files = readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!/\.ya?ml$/i.test(file)) continue;
        names.add(file.replace(/\.ya?ml$/i, ''));
      }
    }
    return [...names];
  }
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const personaName = (config.persona as string) || 'default';
  const personasDir = (config.personasDir as string) || 'data/personas';
  const configDir = ctx.config.getConfigDir();

  // 收集所有候选目录
  const searchDirs = [
    resolve(process.cwd(), personasDir),
    resolve(configDir, 'personas'),
  ];

  /** 在目录中按文件名精确匹配 .yaml/.yml 文件 */
  function findCard(): { card: PersonaCard; path: string } | undefined {
    for (const dir of searchDirs) {
      for (const ext of ['.yaml', '.yml']) {
        const p = resolve(dir, `${personaName}${ext}`);
        if (existsSync(p)) {
          const result = tryLoadCard(p);
          if (result) return { card: result, path: p };
        }
      }
    }
    return undefined;
  }

  function tryLoadCard(filePath: string): PersonaCard | undefined {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown>;
      return {
        name: (parsed.name as string) ?? '',
        description: (parsed.description as string) ?? '',
        prompt: (parsed.prompt as string) ?? '',
        traits: parsed.traits as string[] | undefined,
        greeting: parsed.greeting as string | undefined,
        outputFormat: parsed.outputFormat as PersonaCard['outputFormat'] | undefined,
      };
    } catch {
      return undefined;
    }
  }

  let card: PersonaCard;
  const found = findCard();

  if (found) {
    card = found.card;
    ctx.logger.info(`已加载角色卡: ${card.name} (${found.path})`);
  } else {
    card = {
      name: 'Aalis',
      description: '一个友好的 AI 助手',
      prompt: '请友好、专业地与用户交流。',
    };
    ctx.logger.info(`未找到角色卡 "${personaName}"，使用默认角色`);
  }

  const service = new PersonaServiceImpl(card, searchDirs, personaName as string);
  ctx.provide('persona', service);

  // 当角色卡配置了 outputFormat 时，注册 response:before 钩子解析 JSON
  const outputFormat = service.getOutputFormat();
  if (outputFormat) {
    ctx.logger.info(`角色卡启用结构化输出 (回复字段: ${outputFormat.replyField})`);

    ctx.middleware('response:before', async (data, next) => {
      await next();
      const raw = data.content.trim();
      // 尝试提取 JSON（兼容模型偶尔附加 markdown 代码块标记）
      const jsonStr = raw.startsWith('{')
        ? raw
        : raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      try {
        const parsed = JSON.parse(jsonStr);
        const reply = parsed[outputFormat.replyField];
        if (typeof reply === 'string' && reply.length > 0) {
          data.content = reply;
          ctx.logger.debug(`outputFormat 解码成功，提取字段: ${outputFormat.replyField}`);
        }
      } catch {
        // 解析失败时保留原始内容，不影响正常流程
        ctx.logger.debug('outputFormat 解码失败，保留原始回复');
      }
    });
  }
}

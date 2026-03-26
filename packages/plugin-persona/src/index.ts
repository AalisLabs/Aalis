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
  statePersistence: {
    type: 'boolean',
    label: '状态持久化',
    description: '启用后，角色状态（好感度、心情等 outputFormat 字段）会在对话间持久保存并注入到下一轮提示中',
    default: false,
  },
  timeInjection: {
    type: 'boolean',
    label: '时间注入',
    description: '启用后，当前时间会自动注入到系统提示中',
    default: false,
  },
};

export const defaultConfig = {
  persona: 'default',
  personasDir: 'data/personas',
  statePersistence: false,
  timeInjection: false,
};

// ===== 角色卡格式 =====

interface PlatformOverride {
  /** 追加到基础 prompt 的内容 */
  appendPrompt?: string;
  /** 完全替换基础 prompt（优先于 appendPrompt） */
  prompt?: string;
  /** 替换 description */
  description?: string;
  /** 替换 traits */
  traits?: string[];
  /** 禁用结构化输出格式（该平台回复纯文本） */
  disableOutputFormat?: boolean;
}

interface PersonaCard {
  name: string;
  description: string;
  prompt: string;
  traits?: string[];
  greeting?: string;
  outputFormat?: Record<string, { description: string; reply?: boolean }>;
  nick_name?: string[];
  mute_keyword?: string[];
  /** 按平台标识覆盖/追加角色卡字段 */
  platformOverrides?: Record<string, PlatformOverride>;
}

// ===== 实现 =====

class PersonaServiceImpl implements PersonaService {
  private card: PersonaCard;
  private _outputFormat?: OutputFormat;
  private searchDirs: string[];
  private fileName: string;
  private statePersistence: boolean;
  private timeInjection: boolean;

  /** 每个 session 的持久化状态 */
  private sessionStates = new Map<string, Record<string, unknown>>();
  /** 当前正在处理的 sessionId（由 message:before 中间件设置） */
  currentSessionId?: string;
  /** 当前会话类型 */
  currentSessionType?: 'group' | 'private' | 'channel';
  /** 当前消息发送者 ID */
  currentUserId?: string;
  /** 当前平台标识 */
  currentPlatform?: string;
  /** 当前群名称（仅群聊时可用） */
  currentGroupName?: string;

  constructor(
    card: PersonaCard,
    searchDirs: string[],
    fileName: string,
    options: { statePersistence: boolean; timeInjection: boolean },
  ) {
    this.card = card;
    this.searchDirs = searchDirs;
    this.fileName = fileName;
    this.statePersistence = options.statePersistence;
    this.timeInjection = options.timeInjection;

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

  /** 保存会话状态 */
  saveSessionState(sessionId: string, state: Record<string, unknown>): void {
    this.sessionStates.set(sessionId, state);
  }

  getSystemPrompt(): string {
    let prompt = '';

    // 时间注入
    if (this.timeInjection) {
      const now = new Date();
      const timeStr = now.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      prompt += `当前时间：${timeStr}\n\n`;
    }

    // 解析平台覆盖
    const override = this.currentPlatform
      ? this.card.platformOverrides?.[this.currentPlatform]
      : undefined;

    const description = override?.description ?? this.card.description;
    const traits = override?.traits ?? this.card.traits;
    const basePrompt = override?.prompt ?? this.card.prompt;

    if (this.card.name) {
      prompt += `你的名字是 ${this.card.name}。`;
    }
    if (description) {
      prompt += `${description}\n\n`;
    }
    if (traits && traits.length > 0) {
      prompt += `性格特点: ${traits.join('、')}\n\n`;
    }
    prompt += basePrompt;

    // 追加平台特定内容（仅当未完全替换 prompt 时）
    if (!override?.prompt && override?.appendPrompt) {
      prompt += '\n\n' + override.appendPrompt;
    }

    // 会话上下文注入
    if (this.currentSessionId) {
      prompt += '\n\n# 当前会话环境\n';
      if (this.currentSessionType === 'group') {
        // 解析 sessionId 提取群号
        const parts = this.currentSessionId.split(':');
        const groupId = parts.length >= 4 ? parts.slice(3).join(':') : undefined;
        prompt += '会话类型：群聊\n';
        if (this.currentGroupName) prompt += `群名称：${this.currentGroupName}\n`;
        if (groupId) prompt += `群号：${groupId}\n`;
      } else if (this.currentSessionType === 'private') {
        prompt += '会话类型：私聊\n';
      } else if (this.currentSessionType === 'channel') {
        prompt += '会话类型：频道\n';
      }
      if (this.currentUserId) {
        prompt += `当前消息发送者 ID：${this.currentUserId}\n`;
      }
    }

    // 状态持久化注入
    if (this.statePersistence && this.currentSessionId) {
      const state = this.sessionStates.get(this.currentSessionId);
      if (state && Object.keys(state).length > 0) {
        prompt += '\n\n# 你上一轮的状态\n';
        prompt += '以下是你上一轮回复中的状态，请基于此状态继续，并根据本轮对话更新：\n';
        for (const [k, v] of Object.entries(state)) {
          prompt += `${k}: ${v}\n`;
        }
      }
    }

    // 追加结构化输出指令（若当前平台禁用则跳过）
    const platformDisabled = this.currentPlatform
      ? this.card.platformOverrides?.[this.currentPlatform]?.disableOutputFormat
      : false;
    if (this._outputFormat && !platformDisabled) {
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

  getNickNames(): string[] {
    return this.card.nick_name ?? [];
  }

  getMuteKeywords(): string[] {
    return this.card.mute_keyword ?? [];
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
  const statePersistence = (config.statePersistence as boolean) ?? false;
  const timeInjection = (config.timeInjection as boolean) ?? false;
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
        nick_name: parsed.nick_name as string[] | undefined,
        mute_keyword: parsed.mute_keyword as string[] | undefined,
        platformOverrides: parsed.platformOverrides as PersonaCard['platformOverrides'] | undefined,
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

  const service = new PersonaServiceImpl(card, searchDirs, personaName as string, {
    statePersistence,
    timeInjection,
  });
  ctx.provide('persona', service);

  // 跟踪当前会话信息（始终启用，用于 session 上下文注入和状态持久化）
  ctx.middleware('message:before', async (data, next) => {
    service.currentSessionId = data.message.sessionId;
    service.currentSessionType = data.message.sessionType;
    service.currentUserId = data.message.userId;
    service.currentPlatform = data.message.platform;
    service.currentGroupName = data.message.groupName;
    try {
      await next();
    } finally {
      service.currentSessionId = undefined;
      service.currentSessionType = undefined;
      service.currentUserId = undefined;
      service.currentPlatform = undefined;
      service.currentGroupName = undefined;
    }
  }, 999); // 最高优先级，保证在所有其他中间件之前设置

  // 当角色卡配置了 outputFormat 时，注册 response:before 钩子解析 JSON
  const outputFormat = service.getOutputFormat();
  if (outputFormat) {
    ctx.logger.info(`角色卡启用结构化输出 (回复字段: ${outputFormat.replyField})`);

    ctx.middleware('response:before', async (data, next) => {
      await next();
      // 当前平台禁用了结构化输出则跳过解析
      if (service.currentPlatform
        && card.platformOverrides?.[service.currentPlatform]?.disableOutputFormat) {
        return;
      }
      const raw = data.content.trim();
      // 尝试提取 JSON（兼容模型偶尔附加 markdown 代码块标记）
      const jsonStr = raw.startsWith('{')
        ? raw
        : raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      try {
        const parsed = JSON.parse(jsonStr);
        let reply = parsed[outputFormat.replyField];

        // 回退：模型可能使用了错误的字段名（如 response 代替 message）
        if (typeof reply !== 'string') {
          const aliases = ['response', 'reply', 'content', 'answer', 'text', 'msg'];
          for (const alias of aliases) {
            if (alias !== outputFormat.replyField && typeof parsed[alias] === 'string') {
              reply = parsed[alias];
              ctx.logger.debug(`outputFormat 回退：模型使用了 "${alias}" 而非 "${outputFormat.replyField}"，已自动纠正`);
              break;
            }
          }
        }

        // 仍未找到：若 JSON 中只有一个字符串字段，使用它
        if (typeof reply !== 'string') {
          const stringEntries = Object.entries(parsed).filter(([, v]) => typeof v === 'string');
          if (stringEntries.length === 1) {
            reply = stringEntries[0][1] as string;
            ctx.logger.debug(`outputFormat 回退：仅一个字符串字段 "${stringEntries[0][0]}"，作为回复使用`);
          }
        }

        if (typeof reply === 'string') {
          // 空字符串表示不回复，非空则提取为回复内容
          data.content = reply;
          // 输出所有字段概要
          const fieldSummary = Object.entries(parsed)
            .filter(([k]) => k !== outputFormat.replyField)
            .map(([k, v]) => {
              const s = typeof v === 'string' ? v : JSON.stringify(v);
              return `${k}=${s.length > 60 ? s.slice(0, 60) + '...' : s}`;
            })
            .join(', ');
          if (reply.length > 0) {
            ctx.logger.debug(`outputFormat 解码成功 [${fieldSummary}] → ${outputFormat.replyField}: ${reply.slice(0, 100)}`);
          } else {
            ctx.logger.debug(`outputFormat 解码成功 [${fieldSummary}] → ${outputFormat.replyField}: (空，静默)`);
          }
          // 状态持久化：保存非回复字段
          if (statePersistence) {
            const state: Record<string, unknown> = {};
            for (const key of Object.keys(outputFormat.fields)) {
              if (key !== outputFormat.replyField && parsed[key] !== undefined) {
                state[key] = parsed[key];
              }
            }
            if (Object.keys(state).length > 0) {
              service.saveSessionState(data.sessionId, state);
              ctx.logger.debug(`状态已持久化 (session=${data.sessionId}): ${JSON.stringify(state)}`);
            }
          }
        }
      } catch {
        // 解析失败时保留原始内容，不影响正常流程
        ctx.logger.debug('outputFormat 解码失败，保留原始回复');
      }
    });
  }
}

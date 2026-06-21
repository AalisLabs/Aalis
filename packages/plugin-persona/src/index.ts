import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConfigSchema, Context } from '@aalis/core';
import type { OutputFormat, OutputFormatField, PersonaService, PersonaSessionOptions } from '@aalis/plugin-persona-api';
import { getPlatformSelfIdentity } from '@aalis/plugin-platform-api';
import { createStorageGateway, type StorageService } from '@aalis/plugin-storage-api';
import type {} from '@aalis/plugin-webui-api'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import { parse as parseYaml } from 'yaml';
import { extractJsonCandidate, tryParseJsonObject } from './json-repair.js';
import '@aalis/plugin-agent-api';
import '@aalis/plugin-memory-api';

/** 当前处理消息的会话身份（经 AsyncLocalStorage 按异步上下文隔离，杜绝并发会话间串档）。 */
interface PersonaIdentity {
  sessionId?: string;
  platform?: string;
  sessionType?: 'group' | 'private' | 'channel';
  selfId?: string;
  selfNickname?: string;
  userId?: string;
  nickname?: string;
  groupName?: string;
  selfRole?: 'owner' | 'admin' | 'member';
  selfTitle?: string;
  senderRole?: 'owner' | 'admin' | 'member';
  senderTitle?: string;
}

export type { OutputFormat, OutputFormatField, PersonaService, PersonaSessionOptions } from '@aalis/plugin-persona-api';

/**
 * 读取 session-manager 服务时使用的最小结构化切片
 * —— 避免 import 全量 `SessionManagerService` 类型带来的包循环。
 * `ctx.getService<T>(name)` 的 T 按设计是消费侧结构化窄化，
 * 消费侧只需声明“我要用的那一部分”。
 */
interface SessionConfigResolver {
  resolveConfig(
    sessionId: string,
    platform?: string,
  ): {
    persona?: string;
    disableOutputFormat?: boolean;
    clientSideJsonRendering?: boolean;
  };
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-persona';
export const displayName = '人设系统';
export const subsystem = 'persona';
export const provides = ['persona'];
export const inject = {
  optional: ['platform'],
};

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
    description: '启用后，角色状态（心情、当前行为等 outputFormat 字段）会在同一会话内延续并注入到下一轮提示中',
    default: false,
  },
  timeInjection: {
    type: 'boolean',
    label: '时间注入',
    description: '启用后，当前时间会自动注入到系统提示中',
    default: true,
  },
  timeZone: {
    type: 'string',
    label: '时区 (IANA)',
    description: '例如 Asia/Shanghai、Europe/London、America/New_York。留空使用系统本地时区。',
    default: '',
  },
};

export const defaultConfig = {
  persona: 'default',
  personasDir: 'data/personas',
  statePersistence: false,
  timeInjection: true,
  timeZone: '',
};

// ===== 角色卡格式 =====

interface PersonaCard {
  name: string;
  description: string;
  prompt: string;
  traits?: string[];
  greeting?: string;
  outputFormat?: Record<string, { description: string; reply?: boolean }>;
  /** 角色卡自定义的「JSON 输出说明」，用于替换插件默认的强制提示文案。
   *  字段 schema 仍由插件根据 outputFormat.fields 自动渲染并附在文本之后。
   *  仅在 outputFormat 存在时生效。 */
  outputFormatPrompt?: string;
  /** outputFormat 校验失败时允许重试的最大次数（不含首次）。缺省 1。 */
  outputFormatRetries?: number;
  nick_name?: string[];
  /** JSON 内容由客户端渲染，服务端不提取回复字段 */
  clientSideJsonRendering?: boolean;
  /** 该角色卡可用的 skill 名称白名单（@aalis/plugin-skills 用于过滤暴露给 LLM 的 skill 列表）。
   *  缺省/undefined 表示不限制；空数组表示该角色不暴露任何 skill。 */
  skills?: string[];
}

// ===== 实现 =====

class PersonaServiceImpl implements PersonaService {
  private card: PersonaCard;
  private _outputFormat?: OutputFormat;
  private fileName: string;
  private statePersistence: boolean;
  private timeInjection: boolean;
  private timeZone: string;
  /** 按名称缓存的角色卡（由启动扫描 + watch 预填） */
  private cardCache = new Map<string, PersonaCard | null>();
  /** 按名称缓存的 OutputFormat */
  private formatCache = new Map<string, OutputFormat | null>();
  /** 启动后扫描到的角色名称（用于 listModels，由启动 + watch 维护） */
  private knownNames = new Set<string>();

  /** 每个 session 的持久化状态 */
  private sessionStates = new Map<string, Record<string, unknown>>();
  /** 当前处理消息的会话身份（按异步上下文隔离，杜绝并发会话间串档）。 */
  private identityStore = new AsyncLocalStorage<PersonaIdentity>();

  constructor(
    card: PersonaCard,
    _searchUris: string[],
    fileName: string,
    options: { statePersistence: boolean; timeInjection: boolean; timeZone: string },
  ) {
    this.card = card;
    this.fileName = fileName;
    this.statePersistence = options.statePersistence;
    this.timeInjection = options.timeInjection;
    this.timeZone = options.timeZone;

    // 解析基础 outputFormat
    if (card.outputFormat) {
      this._outputFormat = PersonaServiceImpl.parseRawOutputFormat(card.outputFormat, card.outputFormatRetries);
    }
  }

  /** 给外部调用：启动时预填 cache（代替原 sync 按需读盘） */
  setCardCacheEntry(name: string, card: PersonaCard | null): void {
    if (card) {
      this.cardCache.set(name, card);
      this.knownNames.add(name);
    } else {
      this.cardCache.set(name, null);
      this.knownNames.delete(name);
    }
    this.formatCache.delete(name);
  }

  removeCardCacheEntry(name: string): void {
    this.cardCache.delete(name);
    this.formatCache.delete(name);
    this.knownNames.delete(name);
  }

  /** 重新加载“主角色卡”（fileName 对应的卡），供 watch 调用 */
  reloadPrimaryCardFromCache(): void {
    const refreshed = this.cardCache.get(this.fileName);
    if (refreshed) {
      this.card = refreshed;
      this._outputFormat = refreshed.outputFormat
        ? PersonaServiceImpl.parseRawOutputFormat(refreshed.outputFormat, refreshed.outputFormatRetries)
        : undefined;
    }
  }

  knownPersonaNames(): string[] {
    return [...this.knownNames];
  }

  /** 解析原始 outputFormat 定义 → OutputFormat 结构 */
  private static parseRawOutputFormat(
    raw: Record<string, { description: string; reply?: boolean; type?: string }>,
    retries?: number,
  ): OutputFormat | undefined {
    const fields: Record<string, OutputFormatField> = {};
    let replyField: string | undefined;
    for (const [key, def] of Object.entries(raw)) {
      const type = (['string', 'number', 'boolean'].includes(def.type ?? '') ? def.type : 'string') as
        | 'string'
        | 'number'
        | 'boolean';
      fields[key] = { description: def.description, type, reply: def.reply };
      if (def.reply) replyField = key;
    }
    if (!replyField) return undefined;
    const normalizedRetries = Number.isFinite(retries) && (retries as number) >= 0 ? Math.floor(retries as number) : 1;
    return { fields, replyField, retries: normalizedRetries };
  }

  /** 保存会话状态 */
  saveSessionState(sessionId: string, state: Record<string, unknown>): void {
    this.sessionStates.set(sessionId, state);
  }

  /** 读取会话状态（用于跨会话工具回报目标 agent 内心情况） */
  getSessionState(sessionId: string): Record<string, unknown> | undefined {
    return this.sessionStates.get(sessionId);
  }

  /** 清除指定会话的状态 */
  clearSessionState(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  /** 清除所有会话状态 */
  clearAllStates(): void {
    this.sessionStates.clear();
  }

  /** 根据 options 获取生效的角色卡（不查 session-manager，由调用方传入） */
  private getEffectiveCard(options?: PersonaSessionOptions): PersonaCard {
    if (options?.persona && options.persona !== this.fileName) {
      return this.loadCard(options.persona) ?? this.card;
    }
    return this.card;
  }

  /** 按名称动态加载角色卡（仅查 cache，启动时预填） */
  private loadCard(name: string): PersonaCard | undefined {
    if (name === this.fileName) return this.card;
    const cached = this.cardCache.get(name);
    return cached ?? undefined;
  }

  /** 获取指定角色卡的 OutputFormat（带缓存） */
  private getCardOutputFormat(card: PersonaCard): OutputFormat | undefined {
    if (card === this.card) return this._outputFormat;
    const key = card.name || '??';
    if (this.formatCache.has(key)) return this.formatCache.get(key) ?? undefined;
    const fmt = card.outputFormat
      ? PersonaServiceImpl.parseRawOutputFormat(card.outputFormat, card.outputFormatRetries)
      : undefined;
    this.formatCache.set(key, fmt ?? null);
    return fmt;
  }

  /** 在指定会话身份的异步上下文内执行（中间件用，使并发会话各自隔离身份，穿透 await 不串）。 */
  runWithIdentity<T>(identity: PersonaIdentity, fn: () => T): T {
    return this.identityStore.run(identity, fn);
  }

  getSystemPrompt(options?: PersonaSessionOptions): string {
    const effectiveCard = this.getEffectiveCard(options);
    let prompt = '';

    // 时间注入
    if (this.timeInjection) {
      const now = new Date();
      // 解析有效时区：配置 > 系统本地
      let tz = this.timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
      // 验证时区合法性，无效时回退到系统本地
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
      } catch {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      }
      // 计算 UTC 偏移（如 +08:00 / -05:00）用于消除歧义
      const offsetParts =
        new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
          .formatToParts(now)
          .find(p => p.type === 'timeZoneName')?.value ?? '';
      const timeStr = now.toLocaleString('zh-CN', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
        hour12: false,
      });
      prompt +=
        '以下时间由系统实时注入，是你回答时间或日期相关问题时应直接使用的权威当前时间。不要质疑它，也不要调用工具再次获取时间。\n';
      prompt += `当前时间：${timeStr}（${tz}${offsetParts ? ` ${offsetParts}` : ''}）\n\n`;
    }

    if (effectiveCard.name) {
      prompt += `你的名字是 ${effectiveCard.name}。`;
    }
    if (effectiveCard.description) {
      prompt += `${effectiveCard.description}\n\n`;
    }
    if (effectiveCard.traits && effectiveCard.traits.length > 0) {
      prompt += `性格特点: ${effectiveCard.traits.join('、')}\n\n`;
    }
    prompt += effectiveCard.prompt;

    // 会话上下文注入（身份取自异步上下文隔离的 identityStore，杜绝并发会话串档）
    const id = this.identityStore.getStore();
    if (id?.sessionId) {
      prompt += '\n\n# 当前会话环境\n';
      if (id.platform) {
        prompt += `当前平台：${id.platform}\n`;
      }
      if (id.selfId || id.selfNickname) {
        const selfLabel = id.selfNickname ? `${id.selfNickname}${id.selfId ? `（${id.selfId}）` : ''}` : id.selfId;
        prompt += `你在当前平台的账号：${selfLabel}\n`;
      }
      if (id.sessionType === 'group') {
        // 解析 sessionId 提取群号
        const parts = id.sessionId.split(':');
        const groupId = parts.length >= 4 ? parts.slice(3).join(':') : undefined;
        prompt += '会话类型：群聊\n';
        if (id.groupName) prompt += `群名称：${id.groupName}\n`;
        if (groupId) prompt += `群号：${groupId}\n`;
        // 自身群身份（关键：避免 LLM 误以为自己是普通群员）
        if (id.selfRole) {
          const roleLabel = id.selfRole === 'owner' ? '群主' : id.selfRole === 'admin' ? '管理员' : '普通成员';
          prompt += `你在该群的身份：${roleLabel}\n`;
        }
        if (id.selfTitle) {
          prompt += `你在该群的专属头衔：${id.selfTitle}\n`;
        }
      } else if (id.sessionType === 'private') {
        prompt += '会话类型：私聊\n';
      } else if (id.sessionType === 'channel') {
        prompt += '会话类型：频道\n';
      }
      if (id.userId) {
        prompt += `当前消息发送者 ID：${id.userId}\n`;
      }
      if (id.nickname) {
        prompt += `当前消息发送者昵称：${id.nickname}\n`;
      }
      if (id.senderRole) {
        const senderRoleLabel = id.senderRole === 'owner' ? '群主' : id.senderRole === 'admin' ? '管理员' : '普通成员';
        prompt += `当前消息发送者群身份：${senderRoleLabel}\n`;
      }
      if (id.senderTitle) {
        prompt += `当前消息发送者群头衔：${id.senderTitle}\n`;
      }
      prompt +=
        '短期历史范围：上下文中的历史消息均来自当前会话，即上述群聊/私聊/频道；跨会话或跨群内容只会以长期记忆片段形式单独标注。\n';
    }

    // 状态持久化注入
    if (this.statePersistence) {
      const state = id?.sessionId ? this.sessionStates.get(id.sessionId) : undefined;
      if (state && Object.keys(state).length > 0) {
        prompt += '\n\n# 你上一轮的状态\n';
        prompt += '以下是你上一轮回复中的角色状态，请基于此状态继续，并根据本轮对话更新：\n';
        for (const [k, v] of Object.entries(state)) {
          prompt += `${k}: ${v}\n`;
        }
      }
    }

    // 追加结构化输出指令 — 尊重调用方传入的 disableOutputFormat
    const effectiveFormat = options?.disableOutputFormat ? undefined : this.getCardOutputFormat(effectiveCard);
    if (effectiveFormat) {
      // 角色卡若提供 outputFormatPrompt，则用其替换默认 header/footer；
      // schema 块仍由插件根据 fields 自动生成，避免与字段定义脱节。
      const customPrompt = effectiveCard.outputFormatPrompt?.trim();
      prompt += '\n\n';
      if (customPrompt) {
        prompt += `${customPrompt}\n`;
      } else {
        prompt += '# 输出格式（必须严格遵守）\n';
        prompt +=
          '你的每一条文字回复都必须且只能是一个合法 JSON 对象。不得在 JSON 前后输出任何其他内容，不得使用 markdown 代码块包裹。\n\n';
      }
      prompt += '{\n';
      const entries = Object.entries(effectiveFormat.fields);
      entries.forEach(([key, field], i) => {
        const comma = i < entries.length - 1 ? ',' : '';
        let placeholder: string;
        if (field.type === 'number') placeholder = '0';
        else if (field.type === 'boolean') placeholder = 'true';
        else placeholder = '"..."';
        prompt += `  "${key}": ${placeholder}${comma}\n`;
      });
      prompt += '}\n';
      if (!customPrompt) {
        // 单独输出字段说明，避免行内注释干扰 JSON 解析
        prompt += '\n字段说明：\n';
        entries.forEach(([key, field]) => {
          prompt += `- ${key}：${field.description}${field.reply ? '（发送给用户的回复，不想说话则填空字符串）' : ''}\n`;
        });
        prompt += '\n调用工具时无需遵守此格式，正常使用工具即可。\n';
        prompt += '工具全部调用完毕后，必须按上述 JSON 格式输出最终回复，不得输出纯文本。';
      }
    }

    return prompt;
  }

  getPersonaName(): string {
    return this.card.name || `${this.fileName}，未设置名字`;
  }

  /** 该角色卡是否配置为客户端渲染 JSON */
  isClientSideJsonRendering(options?: PersonaSessionOptions): boolean {
    if (options?.clientSideJsonRendering !== undefined) {
      return options.clientSideJsonRendering;
    }
    const effectiveCard = this.getEffectiveCard(options);
    return !!effectiveCard.clientSideJsonRendering;
  }

  getOutputFormat(options?: PersonaSessionOptions): OutputFormat | undefined {
    if (options?.disableOutputFormat) return undefined;
    const effectiveCard = this.getEffectiveCard(options);
    return this.getCardOutputFormat(effectiveCard);
  }

  getNickNames(): string[] {
    return this.card.nick_name ?? [];
  }

  isTimeInjectionEnabled(): boolean {
    return this.timeInjection;
  }

  getPersonaSkills(options?: PersonaSessionOptions): string[] | undefined {
    const effectiveCard = this.getEffectiveCard(options);
    return effectiveCard.skills;
  }

  async listModels(): Promise<string[]> {
    return [...this.knownNames];
  }
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const personaName = (config.persona as string) || 'default';
  const personasDirRaw = (config.personasDir as string) || 'data/personas';
  const statePersistence = (config.statePersistence as boolean) ?? false;
  const timeInjection = (config.timeInjection as boolean) ?? false;
  const timeZone = (config.timeZone as string) ?? '';

  const storage = createStorageGateway(ctx);

  // 把 "data/personas" / "abc:/path" 都规范化为 storage URI
  function toStorageUri(input: string): string {
    if (input.includes(':/')) return input;
    const s = input.trim().replace(/^\.?\/+/, '');
    const idx = s.indexOf('/');
    return idx > 0 ? `${s.slice(0, idx)}:/${s.slice(idx + 1)}` : `${s}:/`;
  }

  // 候选目录：用户配置 + configDir/personas（若存在 configDir 根，则用 configDir 根；否则跳过）
  const searchUris: string[] = [toStorageUri(personasDirRaw)];
  const knownRoots = new Set(storage.listRoots().map(r => r.name));
  if (knownRoots.has('configDir')) searchUris.push('configDir:/personas');

  async function tryLoadCardFromUri(uri: string): Promise<PersonaCard | undefined> {
    try {
      const raw = (await storage.readFile(uri, 'utf-8')) as string;
      const parsed = parseYaml(raw) as Record<string, unknown>;
      return {
        name: (parsed.name as string) ?? '',
        description: (parsed.description as string) ?? '',
        prompt: (parsed.prompt as string) ?? '',
        traits: parsed.traits as string[] | undefined,
        greeting: parsed.greeting as string | undefined,
        outputFormat: parsed.outputFormat as PersonaCard['outputFormat'] | undefined,
        outputFormatPrompt: parsed.outputFormatPrompt as string | undefined,
        nick_name: parsed.nick_name as string[] | undefined,
        clientSideJsonRendering: parsed.clientSideJsonRendering as boolean | undefined,
        skills: parsed.skills as string[] | undefined,
      };
    } catch {
      return undefined;
    }
  }

  function joinUri(base: string, sub: string): string {
    const s = sub.replace(/^\/+/, '');
    return base.endsWith('/') ? base + s : `${base}/${s}`;
  }

  async function findCard(name: string): Promise<{ card: PersonaCard; uri: string } | undefined> {
    for (const dir of searchUris) {
      for (const ext of ['.yaml', '.yml']) {
        const uri = joinUri(dir, `${name}${ext}`);
        const card = await tryLoadCardFromUri(uri);
        if (card) return { card, uri };
      }
    }
    return undefined;
  }

  /** 扫描所有 personas 目录，预填 cache。 */
  async function scanAll(svc: PersonaServiceImpl): Promise<Set<string>> {
    const seenNames = new Set<string>();
    for (const dir of searchUris) {
      let result: Awaited<ReturnType<StorageService['list']>>;
      try {
        result = await storage.list(dir);
      } catch {
        continue;
      }
      for (const entry of result.entries) {
        if (entry.isDirectory) continue;
        const m = /^(.+)\.ya?ml$/i.exec(entry.name);
        if (!m) continue;
        const cardName = m[1];
        if (seenNames.has(cardName)) continue;
        const card = await tryLoadCardFromUri(entry.uri);
        if (card) {
          svc.setCardCacheEntry(cardName, card);
          seenNames.add(cardName);
        }
      }
    }
    return seenNames;
  }

  let card: PersonaCard;
  const found = await findCard(personaName);
  if (found) {
    card = found.card;
    ctx.logger.info(`已加载角色卡: ${card.name} (${found.uri})`);
  } else {
    card = {
      name: 'Aalis',
      description: '一个友好的 AI 助手',
      prompt: '请友好、专业地与用户交流。',
    };
    ctx.logger.info(`未找到角色卡 "${personaName}"，使用默认角色`);
  }

  const service = new PersonaServiceImpl(card, searchUris, personaName as string, {
    statePersistence,
    timeInjection,
    timeZone,
  });
  ctx.provide('persona', service);

  // 启动时一次性预扫所有 personas → cache（用于 listModels / 动态切换）+ 启动 watch
  ctx.on('ready', async () => {
    try {
      const known = await scanAll(service);
      // 删除 cache 里那些已不存在的
      for (const n of service.knownPersonaNames()) {
        if (!known.has(n) && n !== personaName) service.removeCardCacheEntry(n);
      }
      service.reloadPrimaryCardFromCache();
      ctx.logger.debug(`persona 启动扫描完成，已知 ${known.size} 张卡`);
    } catch (err) {
      ctx.logger.warn(`persona 启动扫描失败：${err}`);
    }
    for (const dir of searchUris) {
      try {
        const unwatch = storage.watch?.(dir, async () => {
          try {
            const known = await scanAll(service);
            for (const n of service.knownPersonaNames()) {
              if (!known.has(n) && n !== personaName) service.removeCardCacheEntry(n);
            }
            service.reloadPrimaryCardFromCache();
            ctx.logger.debug(`persona 目录变化已重新加载（${dir}）`);
          } catch (err) {
            ctx.logger.warn(`persona 重扫失败：${err}`);
          }
        });
        if (unwatch) ctx.onDispose(unwatch);
      } catch (err) {
        ctx.logger.warn(`persona 目录监听失败（${dir}）：${err}`);
      }
    }
  });

  // 参与 memory:clear 清除当前会话的 persona 状态
  ctx.middleware(
    'memory:clear',
    async (
      data: {
        scope: 'session' | 'all';
        types?: string[];
        sessionId?: string;
        results: Array<{ source: string; success: boolean; message: string }>;
      },
      next,
    ) => {
      // 类型过滤：仅在清除 context/persona/全部 时参与
      if (data.types && !data.types.includes('context') && !data.types.includes('persona')) {
        await next();
        return;
      }

      try {
        if (data.scope === 'all') {
          service.clearAllStates();
          data.results.push({ source: 'persona', success: true, message: '所有会话角色状态已清空' });
        } else if (data.sessionId) {
          service.clearSessionState(data.sessionId);
          data.results.push({ source: 'persona', success: true, message: '当前会话角色状态已清空' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        data.results.push({ source: 'persona', success: false, message: `角色状态清空失败: ${msg}` });
      }
      await next();
    },
  );

  // 跟踪当前会话信息（始终启用）：身份装进 AsyncLocalStorage 的异步上下文，
  // 穿透 await 不串、并发会话各自隔离——杜绝跨会话身份泄漏进他人 LLM 提示。
  ctx.middleware('agent:input:before', async (data, next) => {
    const selfIdentity = getPlatformSelfIdentity(ctx, data.message.platform, data.message.sessionId);
    const identity: PersonaIdentity = {
      sessionId: data.message.sessionId,
      platform: data.message.platform,
      sessionType: data.message.sessionType,
      selfId: selfIdentity?.selfId,
      selfNickname: selfIdentity?.nickname,
      userId: data.message.userId,
      nickname: data.message.nickname,
      groupName: data.message.groupName,
      selfRole: data.message.selfRole,
      selfTitle: data.message.selfTitle,
      senderRole: data.message.senderRole,
      senderTitle: data.message.senderTitle,
    };
    await service.runWithIdentity(identity, () => next());
  });

  // agent:reply:before 钩子：统一处理 JSON 解析
  // 1. 有 outputFormat 时：结构化解析 + 状态持久化
  // 2. 无 outputFormat 时：回退提取（模型意外用 JSON 包裹回复时自动解包）
  const baseFormat = service.getOutputFormat();

  if (baseFormat) {
    ctx.logger.info(`角色卡启用结构化输出 (回复字段: ${baseFormat.replyField})`);
  }

  ctx.middleware('agent:reply:before', async (data, next) => {
    await next();

    // 从 session-manager 构造 PersonaSessionOptions，统一传给 service 方法
    let personaOpts: PersonaSessionOptions | undefined;
    try {
      const sm = ctx.getService<SessionConfigResolver>('session-manager');
      if (sm && data.sessionId) {
        const resolved = sm.resolveConfig(data.sessionId, data.platform);
        personaOpts = {
          persona: resolved.persona,
          disableOutputFormat: resolved.disableOutputFormat,
          clientSideJsonRendering: resolved.clientSideJsonRendering,
        };
      }
    } catch {
      /* session-manager 不可用，使用全局默认 */
    }

    const outputFormat = service.getOutputFormat(personaOpts);

    // ===== 无 outputFormat：回退 JSON 提取 =====
    // 当角色卡未定义 outputFormat 时，模型偶尔仍会用 JSON 包裹回复
    // 此处自动解包，提取回复字段
    if (!outputFormat) {
      const trimmed = data.content.trim();
      if (!trimmed.startsWith('{')) return;
      const { parsed: obj } = tryParseJsonObject(trimmed);
      if (!obj) return;
      const replyKeys = ['response', 'reply', 'content', 'answer', 'text', 'msg', 'message'];
      for (const key of replyKeys) {
        if (typeof obj[key] === 'string') {
          data.content = obj[key] as string;
          ctx.logger.debug(`JSON 回退提取: 使用字段 "${key}"`);
          return;
        }
      }
      return;
    }

    // ===== 有 outputFormat：结构化解析 =====

    const clientRendered = service.isClientSideJsonRendering(personaOpts);

    const persistStateFromParsed = (parsedObj: Record<string, unknown>, fmt: OutputFormat): void => {
      const state: Record<string, unknown> = {};
      for (const key of Object.keys(fmt.fields)) {
        if (key !== fmt.replyField && parsedObj[key] !== undefined) {
          const fieldType = fmt.fields[key].type ?? 'string';
          let val = parsedObj[key];
          if (fieldType === 'number') {
            const n = Number(val);
            val = Number.isNaN(n) ? val : n;
          } else if (fieldType === 'boolean') {
            if (typeof val === 'string') val = val === 'true';
            else val = Boolean(val);
          } else {
            if (typeof val !== 'string') val = String(val);
          }
          state[key] = val;
        }
      }
      if (Object.keys(state).length > 0) {
        service.saveSessionState(data.sessionId, state);
        ctx.logger.debug(`状态已持久化 (session=${data.sessionId}): ${JSON.stringify(state)}`);
      }
    };

    const jsonStr = extractJsonCandidate(data.content);
    const { parsed, repairsApplied } = tryParseJsonObject(jsonStr);
    if (parsed && repairsApplied.length > 0) {
      ctx.logger.debug(`outputFormat JSON 自动修复成功：${repairsApplied.join(' → ')}`);
    }
    try {
      if (!parsed) throw new Error('JSON 解析失败');
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
        if (parsed[outputFormat.replyField] !== reply) {
          parsed[outputFormat.replyField] = reply;
        }

        // 严格字段校验：声明的所有字段都必须出现且类型正确，缺一不可 → 否则 retry。
        // 这样可以避免模型养成省略 state/mood 等状态字段的坏习惯，让上下文信号始终完整。
        const missing: string[] = [];
        const typeMismatch: string[] = [];
        for (const [key, def] of Object.entries(outputFormat.fields)) {
          const val = parsed[key];
          if (val === undefined || val === null) {
            missing.push(key);
            continue;
          }
          const expectedType = def.type ?? 'string';
          const actualType = typeof val;
          if (expectedType === 'number') {
            if (actualType !== 'number' && !(actualType === 'string' && !Number.isNaN(Number(val)))) {
              typeMismatch.push(`${key}(期望 number, 实际 ${actualType})`);
            }
          } else if (expectedType === 'boolean') {
            if (actualType !== 'boolean' && !(actualType === 'string' && (val === 'true' || val === 'false'))) {
              typeMismatch.push(`${key}(期望 boolean, 实际 ${actualType})`);
            }
          } else if (actualType !== 'string') {
            typeMismatch.push(`${key}(期望 string, 实际 ${actualType})`);
          }
        }
        if (missing.length > 0 || typeMismatch.length > 0) {
          const parts: string[] = [];
          if (missing.length > 0) parts.push(`缺失字段: ${missing.join(',')}`);
          if (typeMismatch.length > 0) parts.push(`类型错误: ${typeMismatch.join(',')}`);
          throw new Error(parts.join('; '));
        }

        data.archiveContent = JSON.stringify(parsed);

        // 客户端渲染模式：保留完整 JSON 给前端，不提取回复字段
        if (!clientRendered) {
          data.content = reply;
        }
        // 输出所有字段概要
        const fieldSummary = Object.entries(parsed)
          .filter(([k]) => k !== outputFormat.replyField)
          .map(([k, v]) => {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            return `${k}=${s.length > 60 ? `${s.slice(0, 60)}...` : s}`;
          })
          .join(', ');
        if (reply.length > 0) {
          ctx.logger.debug(
            `outputFormat 解码成功 [${fieldSummary}] → ${outputFormat.replyField}: ${reply.slice(0, 100)}`,
          );
        } else {
          ctx.logger.debug(`outputFormat 解码成功 [${fieldSummary}] → ${outputFormat.replyField}: (空，静默)`);
        }
        // 状态持久化：保存非回复字段（按 field type 强制类型）
        if (statePersistence) {
          persistStateFromParsed(parsed, outputFormat);
        }
      } else {
        // JSON 合法但找不到回复字段（无 replyField、无 alias、也不是单字符串字段）
        // 视为模型违约 → 抛错让 catch 触发 retry，要求重新输出符合 outputFormat 的 JSON。
        // 注意：agent 主动静默的合法表达是 reply 字段=空字符串（如 {"message":"","state":"..."}），
        // 那种情况会走上面的 typeof reply === 'string' 分支并被识别为"(空，静默)"。
        throw new Error(
          `JSON 合法但找不到回复字段 "${outputFormat.replyField}"（实际字段: ${Object.keys(parsed).join(',')}）`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const preview = jsonStr.length > 300 ? `${jsonStr.slice(0, 300)}...` : jsonStr;

      const maxRetries = outputFormat.retries;
      const attempt = data.attempt ?? 0;
      // 把允许的重试次数透给 agent，agent 据此决定循环次数
      data.maxRetries = maxRetries;

      if (attempt < maxRetries) {
        // 还有重试名额：要求模型严格按照 outputFormat 重新输出 JSON
        ctx.logger.debug(
          `outputFormat 解码失败 (attempt=${attempt}/${maxRetries})，请求重试：${message}; json=${preview}`,
        );
        const fieldSpec = Object.entries(outputFormat.fields)
          .map(
            ([k, v]) =>
              `  - "${k}"（${v.description ?? ''}${k === outputFormat.replyField ? '；最终回复内容写在这里' : ''}）`,
          )
          .join('\n');
        data.retryRequested = true;
        data.retryFeedback =
          '你的上一条回复没有按照规定的 JSON 输出格式返回（解析失败原因：' +
          message +
          '）。请严格按照以下字段输出一个合法 JSON 对象（不要包 markdown 代码块，所有声明的字段都必须出现，缺一不可）：\n' +
          fieldSpec +
          '\n请勿输出任何 JSON 之外的文本。' +
          '\n注意：如果你的本意只是"汇报已完成 / 不想再对外发送新内容"，请把回复字段留空（空字符串），仅用其他状态字段说明情况——不要省略任何字段，也不要在回复字段里写汇报性文字，否则会被当作新消息发送到对方平台。';
      } else {
        // 重试用尽：静默丢弃（避免原始 JSON 被当成回复发出）
        // 同时通过 archiveContent 写入一条"系统提醒"，让下一轮 LLM 看到自己上次因格式不符被丢弃
        ctx.logger.warn(
          `outputFormat 解码连续 ${attempt + 1} 次失败（已用尽 ${maxRetries} 次重试），静默丢弃回复：${message}; json=${preview}`,
        );
        data.retryRequested = false;
        data.retryFeedback = undefined;
        data.content = '';
        data.archiveContent = `（系统提示：上一条回复因不符合 outputFormat 规定被丢弃，原因：${message}。下次回复请严格按照 system prompt 中规定的 JSON 格式输出，所有声明的字段都必须出现。）`;
      }
    }
  });
}

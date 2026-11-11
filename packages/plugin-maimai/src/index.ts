import { type CommandArgv, commands } from '@aalis/api-commands';
import { type MemoryService, memory } from '@aalis/api-memory';
import { originChatOf, sessionManager } from '@aalis/api-session-manager';
import { tools } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, type Logger, lifecycle, logger, optional } from '@aalis/core';
import { type ConfigOf, configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { isTextRef, TextError, type TextRef, textLines, textOf, toSource } from '@aalis/schema-i18n';
import { t } from './texts.js';

const configSchema = defineConfig({
  developerToken: {
    type: 'string',
    label: t('developerTokenLabel'),
    required: true,
    description: t('developerTokenDescription'),
    secret: true,
    onInvalid: 'error',
  },
  baseUrl: {
    type: 'string',
    label: 'API Base URL',
    default: 'https://maimai.lxns.net',
    onInvalid: 'error',
    description: t('baseUrlDescription'),
  },
  enableTools: {
    type: 'boolean',
    label: t('enableToolsLabel'),
    default: true,
    onInvalid: 'error',
    description: t('enableToolsDescription'),
  },
  enableCommands: {
    type: 'boolean',
    label: t('enableCommandsLabel'),
    default: true,
    onInvalid: 'error',
    description: t('enableCommandsDescription'),
  },
  defaultBindOnPrivateChat: {
    type: 'boolean',
    label: t('defaultBindOnPrivateChatLabel'),
    default: true,
    onInvalid: 'error',
    description: t('defaultBindOnPrivateChatDescription'),
  },
  timeoutMs: {
    type: 'number',
    label: t('timeoutMsLabel'),
    default: 30000,
    description: t('timeoutMsDescription'),
  },
});

type MaimaiConfig = ConfigOf<typeof configSchema>;

// ===== 类型（仅声明常用字段，其余以 unknown 透传） =====

interface MaiPlayer {
  name: string;
  rating: number;
  friend_code: number;
  course_rank?: number;
  class_rank?: number;
  star?: number;
  trophy?: { id: number; name?: string; color?: string };
  icon?: { id: number; name?: string };
  name_plate?: { id: number; name?: string };
  frame?: { id: number; name?: string };
  upload_time?: string;
}

interface MaiScore {
  id: number;
  song_name?: string;
  level?: string;
  level_index: number;
  achievements: number;
  fc?: string | null;
  fs?: string | null;
  dx_score: number;
  dx_star?: number;
  dx_rating?: number;
  rate?: string;
  type: string;
  play_time?: string;
  upload_time?: string;
  last_played_time?: string;
}

interface MaiBests {
  standard_total: number;
  dx_total: number;
  standard: MaiScore[];
  dx: MaiScore[];
}

interface MaiSong {
  id: number;
  title: string;
  artist: string;
  genre: string;
  bpm: number;
  version: number;
  difficulties?: unknown;
}

const LEVEL_NAMES = ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'Re:MASTER'];

// ===== 能力声明 =====

// memory / tools / commands / sessionManager 都是 optional：缺了只是少一部分功能（绑定不可用、工具或指令无人接、
// 私聊里没绑定时不按调用者的 QQ 号查），不该把整个插件挡在激活闸外。
const uses = {
  tools: optional(tools),
  commands: optional(commands),
  memory: optional(memory),
  sessionManager: optional(sessionManager),
  logger,
  lifecycle,
  config,
};
type Caps = BoundOf<typeof uses>;
type MemoryRef = Caps['memory'];
/** 查询目标要用的：绑定记在记忆后端里，私聊按会话管理记下的聊天窗口认 */
type TargetRefs = Pick<Caps, 'memory' | 'sessionManager'>;

// ===== 持久化（QQ ↔ 好友码 绑定） =====

const BIND_NAMESPACE = 'maimai-binding';

function bindKey(platform: string | undefined, userId: string | undefined): string | null {
  if (!platform || !userId) return null;
  return `${platform}:${userId}`;
}

async function getBoundFriendCode(
  memory: MemoryRef,
  platform: string | undefined,
  userId: string | undefined,
): Promise<number | null> {
  const key = bindKey(platform, userId);
  if (!key) return null;
  if (!memory.present) return null;
  const service = memory.use;
  const data = await service.getMetadata(BIND_NAMESPACE, key);
  const code = data?.friend_code;
  return typeof code === 'number' ? code : null;
}

/** 绑定要存进记忆后端、按发消息的人区分：缺了哪个就返回给用户的一句（含怎么办） */
function bindingStore(
  memory: MemoryRef,
  platform: string | undefined,
  userId: string | undefined,
): { service: MemoryService; key: string } | TextRef {
  const key = bindKey(platform, userId);
  if (!key) return t('unknownSender');
  if (!memory.present) return t('noMemory');
  const service = memory.use;
  return { service, key };
}

// ===== HTTP 客户端 =====

class MaimaiClient {
  constructor(
    private cfg: MaimaiConfig,
    private logger: Logger,
  ) {}

  /** signal 是调用方的中止信号，与 timeoutMs 谁先到按谁停；中止时抛中止原因，不按连不上报 */
  private async request<T = unknown>(
    path: string,
    signal: AbortSignal | undefined,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(path, this.cfg.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: this.cfg.developerToken,
      Accept: 'application/json',
    };
    this.logger.debug(`[maimai] GET ${url.toString()}`);
    let resp: Response;
    let text: string;
    try {
      // 工具执行面与调用方都没有外层超时：对端不应答即那轮对话一直阻塞（与已修的 embedding-openai 同形）。
      // 时限连读响应体一起算：响应头到了、响应体卡住时同样超时
      const timeout = AbortSignal.timeout(Math.max(1000, this.cfg.timeoutMs));
      resp = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      text = await resp.text();
    } catch (err) {
      signal?.throwIfAborted();
      // 超时或连不上：底层原因常在 cause 里（fetch 只说 fetch failed）
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause : err).message : String(err);
      throw new TextError(t('unreachable', { reason }), { cause: err });
    }
    let body: { success?: boolean; code?: number; message?: string; data?: T } | undefined;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    if (!resp.ok || (body && body.success === false)) {
      const msg = String(body?.message || `HTTP ${resp.status}`);
      if (resp.status === 401 || resp.status === 403) {
        throw new TextError(t('badToken', { status: resp.status, message: msg }));
      }
      throw new TextError(t('replied', { message: msg }));
    }
    if (body && 'data' in body) return body.data as T;
    return text as unknown as T;
  }

  getPlayer(friendCode: number, signal: AbortSignal | undefined): Promise<MaiPlayer> {
    return this.request<MaiPlayer>(`/api/v0/maimai/player/${friendCode}`, signal);
  }

  getPlayerByQQ(qq: number, signal: AbortSignal | undefined): Promise<MaiPlayer> {
    return this.request<MaiPlayer>(`/api/v0/maimai/player/qq/${qq}`, signal);
  }

  getBests(friendCode: number, signal: AbortSignal | undefined): Promise<MaiBests> {
    return this.request<MaiBests>(`/api/v0/maimai/player/${friendCode}/bests`, signal);
  }

  getApBests(friendCode: number, signal: AbortSignal | undefined): Promise<MaiBests> {
    return this.request<MaiBests>(`/api/v0/maimai/player/${friendCode}/bests/ap`, signal);
  }

  getRecents(friendCode: number, signal: AbortSignal | undefined): Promise<MaiScore[]> {
    return this.request<MaiScore[]>(`/api/v0/maimai/player/${friendCode}/recents`, signal);
  }

  getSongList(signal: AbortSignal | undefined): Promise<{ songs: MaiSong[] }> {
    return this.request<{ songs: MaiSong[] }>(`/api/v0/maimai/song/list`, signal, { notes: false });
  }

  getAliasList(signal: AbortSignal | undefined): Promise<{ aliases: Array<{ song_id: number; aliases: string[] }> }> {
    return this.request<{ aliases: Array<{ song_id: number; aliases: string[] }> }>(
      `/api/v0/maimai/alias/list`,
      signal,
    );
  }
}

// ===== 工具/指令共享逻辑 =====
//
// 回复是文字对象：指令交给出口按读者语言渲染，工具取它的原文交给模型。

interface ResolveResult {
  friend_code?: number;
  qq?: number;
  source: 'arg-friend' | 'arg-qq' | 'bound' | 'private-self' | 'none';
  hint?: TextRef;
}

/** 会话所在的聊天窗口是一对一的（会话管理记下的，子会话取根会话的）；没有会话管理或会话没有聊天窗口时为 false */
function inOneToOneChat(sessions: Caps['sessionManager'], sessionId: string): boolean {
  return originChatOf(sessionId, sessions)?.multiParty === false;
}

/**
 * 根据用户输入和上下文解析要查的目标。
 * 优先级：
 *   1. 显式 friend_code 参数
 *   2. 显式 qq 参数
 *   3. 当前用户已绑定的 friend_code
 *   4. （仅 OneBot 私聊 + 配置允许）以触发者 QQ 查询（可能无对应账号，但让 API 自行判断）
 */
async function resolveTarget(
  refs: TargetRefs,
  cfg: MaimaiConfig,
  callCtx: { sessionId: string; userId?: string; platform?: string },
  args: { friend_code?: unknown; qq?: unknown },
): Promise<ResolveResult> {
  const fc = parseIntStrict(args.friend_code);
  if (fc) return { friend_code: fc, source: 'arg-friend' };
  const qq = parseIntStrict(args.qq);
  if (qq) return { qq, source: 'arg-qq' };

  const bound = await getBoundFriendCode(refs.memory, callCtx.platform, callCtx.userId);
  if (bound) return { friend_code: bound, source: 'bound' };

  // OneBot 私聊（一对一的聊天窗口）里尝试用调用者 QQ 查：查分器账号按 QQ 号登记；一对一窗口里这一轮只有他一个人，
  // 按触发者的 QQ 号查的就是提问的人自己；群里一轮可能有几个人，按触发者查可能查成别人，所以只在一对一窗口里这样查
  if (
    cfg.defaultBindOnPrivateChat &&
    callCtx.platform === 'onebot' &&
    callCtx.userId &&
    inOneToOneChat(refs.sessionManager, callCtx.sessionId)
  ) {
    const userQq = parseIntStrict(callCtx.userId);
    if (userQq) return { qq: userQq, source: 'private-self', hint: t('byQq') };
  }

  return { source: 'none', hint: t('noTargetHint') };
}

function parseIntStrict(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
  }
  return undefined;
}

async function fetchPlayer(
  client: MaimaiClient,
  target: ResolveResult,
  signal: AbortSignal | undefined,
): Promise<MaiPlayer> {
  if (target.friend_code) return client.getPlayer(target.friend_code, signal);
  if (target.qq) return client.getPlayerByQQ(target.qq, signal);
  throw new TextError(t('noTarget'));
}

/** 查询目标是怎么定的（按调用者的 QQ 号查时）：放在回复的第一行 */
function hintLines(target: ResolveResult): TextRef[] {
  return target.hint ? [t('hint', { hint: target.hint })] : [];
}

// ===== 输出格式化 =====

function formatPlayer(p: MaiPlayer): TextRef {
  const lines = [
    t('playerName', { name: String(p.name), rating: String(p.rating) }),
    t('playerCode', { code: String(p.friend_code) }),
  ];
  if (p.trophy?.name) {
    const name = String(p.trophy.name);
    lines.push(
      p.trophy.color ? t('playerTrophyColor', { name, color: String(p.trophy.color) }) : t('playerTrophy', { name }),
    );
  }
  if (typeof p.star === 'number') lines.push(t('playerStar', { star: p.star }));
  if (p.upload_time) lines.push(t('playerSynced', { time: String(p.upload_time) }));
  return textLines(lines);
}

function formatScoreLine(s: MaiScore, idx: number): string {
  const lvIdx = LEVEL_NAMES[s.level_index] ?? `LV${s.level_index}`;
  const ach = (s.achievements ?? 0).toFixed(4);
  const rate = (s.rate ?? '').toUpperCase();
  const fc = s.fc ? ` [${s.fc.toUpperCase()}]` : '';
  const fs = s.fs ? ` [${s.fs.toUpperCase()}]` : '';
  const dxr = typeof s.dx_rating === 'number' ? `  ↑${Math.floor(s.dx_rating)}` : '';
  return `${String(idx).padStart(2, ' ')}. ${s.song_name ?? `#${s.id}`} [${lvIdx} ${s.level ?? ''} ${s.type}]  ${ach}% ${rate}${fc}${fs}${dxr}`;
}

function formatBests(b: MaiBests, opts: { topN?: number } = {}): TextRef {
  const topN = opts.topN ?? 50;
  const total = b.standard_total + b.dx_total;
  return textLines([
    t('bestsTotal', { total, standard: String(b.standard_total), dx: String(b.dx_total) }),
    '',
    t('bestsStandard'),
    ...b.standard.slice(0, topN).map((s, i) => formatScoreLine(s, i + 1)),
    '',
    t('bestsDx'),
    ...b.dx.slice(0, topN).map((s, i) => formatScoreLine(s, i + 1)),
  ]);
}

function formatRecents(scores: MaiScore[], limit: number): TextRef {
  if (scores.length === 0) return t('noRecents');
  const sorted = [...scores].sort((a, b) => (b.play_time ?? '').localeCompare(a.play_time ?? '')).slice(0, limit);
  return textLines([
    t('recentsHead', { count: sorted.length }),
    ...sorted.map((s, i) => formatScoreLine(s, i + 1) + (s.play_time ? `  @${s.play_time}` : '')),
  ]);
}

// ===== 曲库（带懒加载缓存） =====

interface SongIndex {
  songs: MaiSong[];
  aliases: Map<number, string[]>;
  lastFetch: number;
}

const SONG_TTL_MS = 60 * 60 * 1000; // 1 小时

async function loadSongIndex(
  client: MaimaiClient,
  cache: { ref: SongIndex | null },
  signal: AbortSignal | undefined,
): Promise<SongIndex> {
  if (cache.ref && Date.now() - cache.ref.lastFetch < SONG_TTL_MS) return cache.ref;
  const [{ songs }, { aliases }] = await Promise.all([
    client.getSongList(signal),
    // 别名取不到时按没有别名缓存曲库；中止不是取不到，不把缺了别名的曲库缓存一小时
    client.getAliasList(signal).catch(() => {
      signal?.throwIfAborted();
      return { aliases: [] as Array<{ song_id: number; aliases: string[] }> };
    }),
  ]);
  const aliasMap = new Map<number, string[]>();
  for (const a of aliases) aliasMap.set(a.song_id, a.aliases);
  const idx: SongIndex = { songs, aliases: aliasMap, lastFetch: Date.now() };
  cache.ref = idx;
  return idx;
}

function searchSongs(idx: SongIndex, keyword: string, limit: number): MaiSong[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  const out: MaiSong[] = [];
  for (const song of idx.songs) {
    const aliases = idx.aliases.get(song.id) ?? [];
    const hay = [String(song.id), song.title, song.artist, ...aliases].join(' ').toLowerCase();
    if (hay.includes(kw)) out.push(song);
    if (out.length >= limit) break;
  }
  return out;
}

function formatSongMatch(song: MaiSong, idx: SongIndex): TextRef {
  const aliases = idx.aliases.get(song.id) ?? [];
  const lines = [
    t('songTitle', { id: String(song.id), title: String(song.title), artist: String(song.artist) }),
    t('songInfo', { genre: String(song.genre), bpm: String(song.bpm), version: String(song.version) }),
  ];
  if (aliases.length) {
    const shown = aliases.slice(0, 6).join(' / ');
    lines.push(
      aliases.length > 6
        ? t('songAliasesMore', { aliases: shown, more: aliases.length - 6 })
        : t('songAliases', { aliases: shown }),
    );
  }
  return textLines(lines);
}

// ===== 插件入口 =====

export default definePlugin({
  name: '@aalis/plugin-maimai',
  displayName: t('displayName'),
  subsystem: 'skills',
  configSchema,
  uses,
  apply({ tools, commands, memory, sessionManager, logger, lifecycle, config }) {
    const cfg = parseConfig(configSchema, config.use, logger.use);
    if (!URL.canParse(cfg.baseUrl) || new URL(cfg.baseUrl).username || new URL(cfg.baseUrl).password) {
      throw configError(t('baseUrlNotPlain'));
    }
    // 请求路径按 baseUrl 解析（new URL），查询串与片段会被静默丢掉；末尾单个 ? 解析后查询串为空，所以按原文判
    if (/[?#]/.test(cfg.baseUrl)) {
      throw configError(t('baseUrlHasQuery'));
    }

    const client = new MaimaiClient(cfg, logger.use);
    const songCache: { ref: SongIndex | null } = { ref: null };
    const refs: TargetRefs = { memory, sessionManager };

    // ===== Agent 工具（结构化参数） =====
    if (cfg.enableTools) {
      tools.use.registerGroup({
        name: 'maimai',
        label: t('displayName'),
        summary: t('groupSummary'),
        description: '查询舞萌 DX 玩家信息、Best 50、最近成绩、曲库等',
      });

      // 玩家信息
      tools.use.register({
        groups: ['maimai'],
        definition: {
          type: 'function',
          function: {
            name: 'maimai_get_player_info',
            description:
              '查询舞萌 DX 玩家基本信息（昵称、DX Rating、好友码、称号等）。可指定 friend_code 或 qq；都不传时使用调用者已绑定的好友码。',
            parameters: {
              type: 'object',
              properties: {
                friend_code: { type: 'string', description: '可选：玩家好友码（数字字符串）' },
                qq: { type: 'string', description: '可选：玩家在查分器绑定的 QQ 号' },
              },
              required: [],
            },
          },
        },
        handler: async (args, callCtx) => toSource(await handleGetPlayer(refs, cfg, client, args, callCtx)),
      });

      // B50
      tools.use.register({
        groups: ['maimai'],
        definition: {
          type: 'function',
          function: {
            name: 'maimai_get_b50',
            description:
              '查询舞萌 DX 玩家的 Best 50（B35 旧版 + B15 现版）。可指定 friend_code 或 qq；都不传时使用调用者已绑定的好友码。',
            parameters: {
              type: 'object',
              properties: {
                friend_code: { type: 'string', description: '可选：玩家好友码' },
                qq: { type: 'string', description: '可选：玩家 QQ 号' },
                ap_only: { type: 'boolean', description: '可选：只返回 All Perfect 50（AP B50），默认 false' },
                top_n: { type: 'number', description: '可选：每个分组最多返回多少条，默认 50（即全部）' },
              },
              required: [],
            },
          },
        },
        handler: async (args, callCtx) => toSource(await handleGetBests(refs, cfg, client, args, callCtx)),
      });

      // Recent
      tools.use.register({
        groups: ['maimai'],
        definition: {
          type: 'function',
          function: {
            name: 'maimai_get_recents',
            description:
              '查询舞萌 DX 玩家最近的游玩记录（按游玩时间降序）。可指定 friend_code 或 qq；都不传时使用调用者已绑定的好友码。',
            parameters: {
              type: 'object',
              properties: {
                friend_code: { type: 'string', description: '可选：玩家好友码' },
                qq: { type: 'string', description: '可选：玩家 QQ 号' },
                limit: { type: 'number', description: '返回条数，默认 10，最大 50' },
              },
              required: [],
            },
          },
        },
        handler: async (args, callCtx) => toSource(await handleGetRecents(refs, cfg, client, args, callCtx)),
      });

      // 搜索曲目
      tools.use.register({
        groups: ['maimai'],
        definition: {
          type: 'function',
          function: {
            name: 'maimai_search_song',
            description:
              '在舞萌 DX 曲库中按曲名/艺术家/别名/曲目 ID 搜索曲目，返回匹配项的基本信息（曲目 ID、艺术家、版本、别名等）。',
            parameters: {
              type: 'object',
              properties: {
                keyword: { type: 'string', description: '搜索关键词（中英日文均可，会匹配标题、艺术家与别名）' },
                limit: { type: 'number', description: '最多返回多少条，默认 5，最大 20' },
              },
              required: ['keyword'],
            },
          },
        },
        handler: async (args, callCtx) => toSource(await handleSearchSong(client, songCache, args, callCtx.signal)),
      });

      // 绑定好友码
      tools.use.register({
        groups: ['maimai'],
        definition: {
          type: 'function',
          function: {
            name: 'maimai_bind_user',
            description: '将调用者（按 platform:userId 区分）绑定到一个查分器好友码。绑定后查询相关工具可省略参数。',
            parameters: {
              type: 'object',
              properties: {
                friend_code: { type: 'string', description: '要绑定的好友码（数字）' },
              },
              required: ['friend_code'],
            },
          },
        },
        handler: async (args, callCtx) => toSource(await handleBind(memory, args, callCtx)),
      });

      tools.use.register({
        groups: ['maimai'],
        definition: {
          type: 'function',
          function: {
            name: 'maimai_unbind_user',
            description: '解绑当前调用者的舞萌 DX 好友码。',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        handler: async (_args, callCtx) => toSource(await handleUnbind(memory, callCtx)),
      });

      logger.use.info('[maimai] Agent 工具已注册');
    }

    // ===== 用户指令（同样的功能，文本入口） =====
    //
    // 设计：Agent 端走结构化原生工具；用户端走指令。两者共用 handle* 函数，指令把回复的文字对象原样交出。
    // 指令的契约不带中止信号：查询接本插件这次激活的，停用、停机时随之停下
    if (cfg.enableCommands) {
      const callCtxOf = (argv: CommandArgv) => ({
        sessionId: argv.session.sessionId,
        userId: argv.session.userId,
        platform: argv.session.platform,
        signal: lifecycle.use.signal,
      });

      // 裸敲 /maimai 回指令系统生成的用法（列出子指令）
      commands.use.command('maimai', t('maimaiDescription'));

      const TARGET = cfg.defaultBindOnPrivateChat ? t('targetOrQq') : t('target');

      commands.use
        .command('maimai.info [target:string]', t('infoDescription'))
        .argument('target', TARGET)
        .action(async (argv, target) => {
          const args = parseTarget(target as string | undefined);
          return handleGetPlayer(refs, cfg, client, args, callCtxOf(argv));
        });

      commands.use
        .command('maimai.b50 [target:string]', t('b50Description'))
        .argument('target', TARGET)
        .option('ap', '--ap', { description: t('apOnly') })
        .action(async (argv, target) => {
          const args = parseTarget(target as string | undefined);
          if (argv.options.ap === true) args.ap_only = true;
          return handleGetBests(refs, cfg, client, args, callCtxOf(argv));
        });

      commands.use
        .command('maimai.recent [target:string] [count:number]', t('recentDescription'))
        .argument('target', TARGET)
        .argument('count', t('recentCount'))
        .action(async (argv, target, count) => {
          const args = parseTarget(target as string | undefined);
          if (count !== undefined) args.limit = count;
          return handleGetRecents(refs, cfg, client, args, callCtxOf(argv));
        });

      commands.use
        .command('maimai.song <keyword:text>', t('songDescription'))
        .argument('keyword', t('songKeyword'))
        .action(async (_argv, keyword) =>
          handleSearchSong(client, songCache, { keyword, limit: 5 }, lifecycle.use.signal),
        );

      commands.use
        .command('maimai.bind <code:string>', t('bindDescription'))
        .argument('code', t('bindCode'))
        .action(async (argv, code) => handleBind(memory, { friend_code: code }, callCtxOf(argv)));

      commands.use
        .command('maimai.unbind', t('unbindDescription'))
        .action(async argv => handleUnbind(memory, callCtxOf(argv)));

      logger.use.info('[maimai] 斜杠指令已注册');
    }
  },
});

// ===== 处理函数（工具与指令共用） =====

/** 查询的上下文：signal 是调用方的中止信号（工具是这次调用的，指令是本插件这次激活的），中止时回复带的是中止原因 */
interface QueryContext {
  sessionId: string;
  userId?: string;
  platform?: string;
  signal?: AbortSignal;
}

async function handleGetPlayer(
  refs: TargetRefs,
  cfg: MaimaiConfig,
  client: MaimaiClient,
  args: Record<string, unknown>,
  callCtx: QueryContext,
): Promise<TextRef> {
  const target = await resolveTarget(refs, cfg, callCtx, args);
  if (target.source === 'none') return target.hint!;
  try {
    const player = await fetchPlayer(client, target, callCtx.signal);
    return textLines([...hintLines(target), formatPlayer(player)]);
  } catch (err) {
    return t('queryFailed', { error: textOf(err) });
  }
}

async function handleGetBests(
  refs: TargetRefs,
  cfg: MaimaiConfig,
  client: MaimaiClient,
  args: Record<string, unknown>,
  callCtx: QueryContext,
): Promise<TextRef> {
  const target = await resolveTarget(refs, cfg, callCtx, args);
  if (target.source === 'none') return target.hint!;
  // bests 接口仅支持 friend_code；若来源是 qq，先 lookup
  let friendCode = target.friend_code;
  try {
    if (!friendCode && target.qq) {
      const p = await client.getPlayerByQQ(target.qq, callCtx.signal);
      friendCode = p.friend_code;
    }
    if (!friendCode) return t('noFriendCode');
    const apOnly = args.ap_only === true;
    const topN = parseIntStrict(args.top_n) ?? 50;
    const bests = apOnly
      ? await client.getApBests(friendCode, callCtx.signal)
      : await client.getBests(friendCode, callCtx.signal);
    return textLines([...hintLines(target), ...(apOnly ? [t('apBests')] : []), formatBests(bests, { topN })]);
  } catch (err) {
    return t('queryFailed', { error: textOf(err) });
  }
}

async function handleGetRecents(
  refs: TargetRefs,
  cfg: MaimaiConfig,
  client: MaimaiClient,
  args: Record<string, unknown>,
  callCtx: QueryContext,
): Promise<TextRef> {
  const target = await resolveTarget(refs, cfg, callCtx, args);
  if (target.source === 'none') return target.hint!;
  let friendCode = target.friend_code;
  try {
    if (!friendCode && target.qq) {
      const p = await client.getPlayerByQQ(target.qq, callCtx.signal);
      friendCode = p.friend_code;
    }
    if (!friendCode) return t('noFriendCode');
    const limit = Math.min(50, Math.max(1, parseIntStrict(args.limit) ?? 10));
    const scores = await client.getRecents(friendCode, callCtx.signal);
    return formatRecents(scores, limit);
  } catch (err) {
    return t('queryFailed', { error: textOf(err) });
  }
}

async function handleSearchSong(
  client: MaimaiClient,
  cache: { ref: SongIndex | null },
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<TextRef> {
  const keyword = String(args.keyword ?? '').trim();
  if (!keyword) return t('noKeyword');
  const limit = Math.min(20, Math.max(1, parseIntStrict(args.limit) ?? 5));
  try {
    const idx = await loadSongIndex(client, cache, signal);
    const matches = searchSongs(idx, keyword, limit);
    if (matches.length === 0) return t('noSong', { keyword });
    // 各条之间空一行
    return textLines([
      t('songsHead', { count: matches.length, keyword }),
      ...matches.flatMap(m => ['', formatSongMatch(m, idx)]),
    ]);
  } catch (err) {
    return t('queryFailed', { error: textOf(err) });
  }
}

async function handleBind(
  memory: MemoryRef,
  args: Record<string, unknown>,
  callCtx: { userId?: string; platform?: string },
): Promise<TextRef> {
  const fc = parseIntStrict(args.friend_code);
  if (!fc) return t('badFriendCode');
  const store = bindingStore(memory, callCtx.platform, callCtx.userId);
  if (isTextRef(store)) return t('bindFailed', { reason: store });
  await store.service.saveMetadata(BIND_NAMESPACE, store.key, { friend_code: fc, updated_at: Date.now() });
  return t('bound', { key: store.key, code: fc });
}

async function handleUnbind(memory: MemoryRef, callCtx: { userId?: string; platform?: string }): Promise<TextRef> {
  const store = bindingStore(memory, callCtx.platform, callCtx.userId);
  if (isTextRef(store)) return t('unbindFailed', { reason: store });
  await store.service.deleteMetadata(BIND_NAMESPACE, store.key);
  return t('unbound');
}

// ===== 指令参数解析 =====

/** 查询目标：qq:数字 → qq；三位以上的纯数字 → friend_code；别的不认（按绑定查） */
function parseTarget(target: string | undefined): Record<string, unknown> {
  if (target && /^qq:\d+$/i.test(target)) return { qq: target.slice(3) };
  if (target && /^\d{3,}$/.test(target)) return { friend_code: target };
  return {};
}

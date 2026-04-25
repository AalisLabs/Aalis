import type {
  Context,
  ConfigSchema,
  ToolCallContext,
  CommandContext,
  MemoryService,
} from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-maimai';
export const displayName = '舞萌 DX 查分';
export const description = '基于 maimai.lxns.net 开发者 API 的舞萌 DX 查分插件，提供指令与 Agent 工具双入口';
export const inject = {};

export const configSchema: ConfigSchema = {
  developerToken: {
    type: 'string',
    label: '开发者 API Token',
    default: '',
    description: '在 https://maimai.lxns.net 申请的开发者 token，必须配置',
    secret: true,
  },
  baseUrl: {
    type: 'string',
    label: 'API Base URL',
    default: 'https://maimai.lxns.net',
    description: '查分器域名，一般无需修改',
  },
  enableTools: {
    type: 'boolean',
    label: '注册 Agent 工具',
    default: true,
    description: '为 LLM Agent 注册结构化工具（推荐保持开启）',
  },
  enableCommands: {
    type: 'boolean',
    label: '注册斜杠指令',
    default: true,
    description: '为用户注册 /maimai 等斜杠指令',
  },
  defaultBindOnPrivateChat: {
    type: 'boolean',
    label: '私聊缺省绑定',
    default: true,
    description: '在 OneBot 私聊中，若调用者未绑定但其 QQ 已注册查分器账号，自动以其 QQ 查分',
  },
};

export const defaultConfig = {
  developerToken: '',
  baseUrl: 'https://maimai.lxns.net',
  enableTools: true,
  enableCommands: true,
  defaultBindOnPrivateChat: true,
};

interface MaimaiConfig {
  developerToken: string;
  baseUrl: string;
  enableTools: boolean;
  enableCommands: boolean;
  defaultBindOnPrivateChat: boolean;
}

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

// ===== 持久化（QQ ↔ 好友码 绑定） =====

const BIND_NAMESPACE = 'maimai-binding';

function bindKey(platform: string | undefined, userId: string | undefined): string | null {
  if (!platform || !userId) return null;
  return `${platform}:${userId}`;
}

async function getBoundFriendCode(ctx: Context, platform: string | undefined, userId: string | undefined): Promise<number | null> {
  const key = bindKey(platform, userId);
  if (!key) return null;
  const memory = ctx.getService<MemoryService>('memory');
  if (!memory?.getMetadata) return null;
  const data = await memory.getMetadata(BIND_NAMESPACE, key);
  const code = data?.friend_code;
  return typeof code === 'number' ? code : null;
}

async function setBoundFriendCode(ctx: Context, platform: string | undefined, userId: string | undefined, friendCode: number): Promise<boolean> {
  const key = bindKey(platform, userId);
  if (!key) return false;
  const memory = ctx.getService<MemoryService>('memory');
  if (!memory?.saveMetadata) return false;
  await memory.saveMetadata(BIND_NAMESPACE, key, { friend_code: friendCode, updated_at: Date.now() });
  return true;
}

async function clearBoundFriendCode(ctx: Context, platform: string | undefined, userId: string | undefined): Promise<boolean> {
  const key = bindKey(platform, userId);
  if (!key) return false;
  const memory = ctx.getService<MemoryService>('memory');
  if (!memory?.deleteMetadata) return false;
  await memory.deleteMetadata(BIND_NAMESPACE, key);
  return true;
}

// ===== HTTP 客户端 =====

class MaimaiClient {
  constructor(private cfg: MaimaiConfig, private logger: { warn: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void }) {}

  private async request<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.cfg.developerToken) {
      throw new Error('未配置 developerToken，请在 aalis.config.yaml 中填入 maimai.lxns.net 申请的开发者 token');
    }
    const url = new URL(path, this.cfg.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      'Authorization': this.cfg.developerToken,
      'Accept': 'application/json',
    };
    this.logger.debug?.(`[maimai] GET ${url.toString()}`);
    const resp = await fetch(url.toString(), { method: 'GET', headers });
    const text = await resp.text();
    let body: { success?: boolean; code?: number; message?: string; data?: T } | undefined;
    try { body = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!resp.ok || (body && body.success === false)) {
      const msg = body?.message || `HTTP ${resp.status}`;
      throw new Error(`maimai API 调用失败: ${msg}`);
    }
    if (body && 'data' in body) return body.data as T;
    return text as unknown as T;
  }

  getPlayer(friendCode: number): Promise<MaiPlayer> {
    return this.request<MaiPlayer>(`/api/v0/maimai/player/${friendCode}`);
  }

  getPlayerByQQ(qq: number): Promise<MaiPlayer> {
    return this.request<MaiPlayer>(`/api/v0/maimai/player/qq/${qq}`);
  }

  getBests(friendCode: number): Promise<MaiBests> {
    return this.request<MaiBests>(`/api/v0/maimai/player/${friendCode}/bests`);
  }

  getApBests(friendCode: number): Promise<MaiBests> {
    return this.request<MaiBests>(`/api/v0/maimai/player/${friendCode}/bests/ap`);
  }

  getRecents(friendCode: number): Promise<MaiScore[]> {
    return this.request<MaiScore[]>(`/api/v0/maimai/player/${friendCode}/recents`);
  }

  getSongList(): Promise<{ songs: MaiSong[] }> {
    return this.request<{ songs: MaiSong[] }>(`/api/v0/maimai/song/list`, { notes: false });
  }

  getAliasList(): Promise<{ aliases: Array<{ song_id: number; aliases: string[] }> }> {
    return this.request<{ aliases: Array<{ song_id: number; aliases: string[] }> }>(`/api/v0/maimai/alias/list`);
  }
}

// ===== 工具/指令共享逻辑 =====

interface ResolveResult {
  friend_code?: number;
  qq?: number;
  source: 'arg-friend' | 'arg-qq' | 'bound' | 'private-self' | 'none';
  hint?: string;
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
  ctx: Context,
  cfg: MaimaiConfig,
  callCtx: { sessionId: string; userId?: string; platform?: string },
  args: { friend_code?: unknown; qq?: unknown },
): Promise<ResolveResult> {
  const fc = parseIntStrict(args.friend_code);
  if (fc) return { friend_code: fc, source: 'arg-friend' };
  const qq = parseIntStrict(args.qq);
  if (qq) return { qq, source: 'arg-qq' };

  const bound = await getBoundFriendCode(ctx, callCtx.platform, callCtx.userId);
  if (bound) return { friend_code: bound, source: 'bound' };

  // OneBot 私聊场景下尝试用调用者 QQ 查
  if (cfg.defaultBindOnPrivateChat && callCtx.platform === 'onebot' && callCtx.userId && callCtx.sessionId.includes(':private:')) {
    const userQq = parseIntStrict(callCtx.userId);
    if (userQq) return { qq: userQq, source: 'private-self', hint: '使用你的 QQ 号查询查分器（如失败请先 /maimai bind <好友码>）' };
  }

  return { source: 'none', hint: '未找到查询目标。请提供 friend_code/qq 参数，或先用 /maimai bind <好友码> 绑定自己。' };
}

function parseIntStrict(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
  }
  return undefined;
}

async function fetchPlayer(client: MaimaiClient, target: ResolveResult): Promise<MaiPlayer> {
  if (target.friend_code) return client.getPlayer(target.friend_code);
  if (target.qq) return client.getPlayerByQQ(target.qq);
  throw new Error('解析目标失败');
}

// ===== 输出格式化 =====

function formatPlayer(p: MaiPlayer): string {
  const lines = [
    `👤 ${p.name}  (DX Rating: ${p.rating})`,
    `🆔 好友码: ${p.friend_code}`,
  ];
  if (p.trophy?.name) lines.push(`🏆 称号: ${p.trophy.name}${p.trophy.color ? ` [${p.trophy.color}]` : ''}`);
  if (typeof p.star === 'number') lines.push(`⭐ 搭档觉醒: ${p.star}`);
  if (p.upload_time) lines.push(`🕒 同步时间: ${p.upload_time}`);
  return lines.join('\n');
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

function formatBests(b: MaiBests, opts: { topN?: number } = {}): string {
  const topN = opts.topN ?? 50;
  const total = b.standard_total + b.dx_total;
  const lines: string[] = [];
  lines.push(`📊 B50 总分: ${total}  (B35 旧版 ${b.standard_total} + B15 现版 ${b.dx_total})`);
  lines.push('');
  lines.push('— 旧版 B35 —');
  b.standard.slice(0, topN).forEach((s, i) => lines.push(formatScoreLine(s, i + 1)));
  lines.push('');
  lines.push('— 现版 B15 —');
  b.dx.slice(0, topN).forEach((s, i) => lines.push(formatScoreLine(s, i + 1)));
  return lines.join('\n');
}

function formatRecents(scores: MaiScore[], limit: number): string {
  if (scores.length === 0) return '（无最近游玩记录）';
  const sorted = [...scores].sort((a, b) => (b.play_time ?? '').localeCompare(a.play_time ?? '')).slice(0, limit);
  const lines: string[] = [`🕘 最近 ${sorted.length} 条游玩记录:`];
  sorted.forEach((s, i) => {
    lines.push(formatScoreLine(s, i + 1) + (s.play_time ? `  @${s.play_time}` : ''));
  });
  return lines.join('\n');
}

// ===== 曲库（带懒加载缓存） =====

interface SongIndex {
  songs: MaiSong[];
  aliases: Map<number, string[]>;
  lastFetch: number;
}

const SONG_TTL_MS = 60 * 60 * 1000; // 1 小时

async function loadSongIndex(client: MaimaiClient, cache: { ref: SongIndex | null }): Promise<SongIndex> {
  if (cache.ref && Date.now() - cache.ref.lastFetch < SONG_TTL_MS) return cache.ref;
  const [{ songs }, { aliases }] = await Promise.all([
    client.getSongList(),
    client.getAliasList().catch(() => ({ aliases: [] as Array<{ song_id: number; aliases: string[] }> })),
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

function formatSongMatch(song: MaiSong, idx: SongIndex): string {
  const aliases = idx.aliases.get(song.id) ?? [];
  const lines = [
    `#${song.id} 《${song.title}》  by ${song.artist}`,
    `  分类: ${song.genre} | BPM: ${song.bpm} | 版本: ${song.version}`,
  ];
  if (aliases.length) lines.push(`  别名: ${aliases.slice(0, 6).join(' / ')}${aliases.length > 6 ? ` ...(+${aliases.length - 6})` : ''}`);
  return lines.join('\n');
}

// ===== 插件入口 =====

export function apply(ctx: Context, rawConfig: Record<string, unknown>): void {
  const cfg: MaimaiConfig = {
    developerToken: String(rawConfig.developerToken ?? ''),
    baseUrl: String(rawConfig.baseUrl ?? 'https://maimai.lxns.net'),
    enableTools: rawConfig.enableTools !== false,
    enableCommands: rawConfig.enableCommands !== false,
    defaultBindOnPrivateChat: rawConfig.defaultBindOnPrivateChat !== false,
  };

  if (!cfg.developerToken) {
    ctx.logger.warn('[maimai] 未配置 developerToken，插件不会注册任何工具/指令');
    return;
  }

  const client = new MaimaiClient(cfg, {
    warn: (m) => ctx.logger.warn(m),
    error: (m) => ctx.logger.error(m),
    debug: (m) => ctx.logger.debug?.(m),
  });
  const songCache: { ref: SongIndex | null } = { ref: null };

  // ===== Agent 工具（结构化参数） =====
  if (cfg.enableTools) {
    ctx.registerToolGroup({
      name: 'maimai',
      label: '舞萌 DX 查分',
      description: '查询舞萌 DX 玩家信息、Best 50、最近成绩、曲库等',
    });

    // 玩家信息
    ctx.registerTool({
      groups: ['maimai'],
      definition: {
        type: 'function',
        function: {
          name: 'maimai_get_player_info',
          description: '查询舞萌 DX 玩家基本信息（昵称、DX Rating、好友码、称号等）。可指定 friend_code 或 qq；都不传时使用调用者已绑定的好友码。',
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
      handler: async (args, callCtx) => handleGetPlayer(ctx, cfg, client, args, callCtx),
    });

    // B50
    ctx.registerTool({
      groups: ['maimai'],
      definition: {
        type: 'function',
        function: {
          name: 'maimai_get_b50',
          description: '查询舞萌 DX 玩家的 Best 50（B35 旧版 + B15 现版）。可指定 friend_code 或 qq；都不传时使用调用者已绑定的好友码。',
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
      handler: async (args, callCtx) => handleGetBests(ctx, cfg, client, args, callCtx),
    });

    // Recent
    ctx.registerTool({
      groups: ['maimai'],
      definition: {
        type: 'function',
        function: {
          name: 'maimai_get_recents',
          description: '查询舞萌 DX 玩家最近的游玩记录（按游玩时间降序）。可指定 friend_code 或 qq；都不传时使用调用者已绑定的好友码。',
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
      handler: async (args, callCtx) => handleGetRecents(ctx, cfg, client, args, callCtx),
    });

    // 搜索曲目
    ctx.registerTool({
      groups: ['maimai'],
      definition: {
        type: 'function',
        function: {
          name: 'maimai_search_song',
          description: '在舞萌 DX 曲库中按曲名/艺术家/别名/曲目 ID 搜索曲目，返回匹配项的基本信息（曲目 ID、艺术家、版本、别名等）。',
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
      handler: async (args) => handleSearchSong(client, songCache, args),
    });

    // 绑定好友码
    ctx.registerTool({
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
      handler: async (args, callCtx) => handleBind(ctx, args, callCtx),
    });

    ctx.registerTool({
      groups: ['maimai'],
      definition: {
        type: 'function',
        function: {
          name: 'maimai_unbind_user',
          description: '解绑当前调用者的舞萌 DX 好友码。',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      handler: async (_args, callCtx) => {
        const ok = await clearBoundFriendCode(ctx, callCtx.platform, callCtx.userId);
        return ok ? '已解绑你的舞萌 DX 好友码' : '解绑失败：记忆服务不可用或未绑定';
      },
    });

    ctx.logger.info('[maimai] Agent 工具已注册');
  }

  // ===== 用户指令（同样的功能，文本入口） =====
  //
  // 设计：Agent 端走结构化原生工具；用户端走指令。两者共用 handle* 函数。
  if (cfg.enableCommands) {
    ctx.command(
      'maimai',
      '舞萌 DX 查分。子指令：info/b50/recent/song/bind/unbind',
      async (cmdCtx) => formatHelp(),
      {
        subcommands: [
          {
            name: 'info',
            description: '查询玩家基本信息：/maimai info [friend_code|qq:<qq>]',
            action: async (c) => {
              const args = parseSubArgs(c);
              const out = await handleGetPlayer(ctx, cfg, client, args, c);
              return out;
            },
          },
          {
            name: 'b50',
            description: '查询 Best 50：/maimai b50 [friend_code|qq:<qq>] [--ap]',
            action: async (c) => {
              const args = parseSubArgs(c);
              if (c.args.includes('--ap')) args.ap_only = true;
              return handleGetBests(ctx, cfg, client, args, c);
            },
          },
          {
            name: 'recent',
            description: '最近游玩：/maimai recent [friend_code|qq:<qq>] [N]',
            action: async (c) => {
              const args = parseSubArgs(c);
              const n = c.args.find(a => /^\d+$/.test(a) && !a.startsWith('qq:'));
              // 第一个数字若已被识别成 friend_code，剩下的数字才是 limit
              const numArgs = c.args.filter(a => /^\d+$/.test(a));
              if (numArgs.length >= 2) args.limit = parseInt(numArgs[1], 10);
              else if (n && !args.friend_code) { /* 已设为 friend_code */ }
              return handleGetRecents(ctx, cfg, client, args, c);
            },
          },
          {
            name: 'song',
            description: '搜索曲目：/maimai song <关键词>',
            action: async (c) => {
              const keyword = c.args.join(' ').trim();
              if (!keyword) return '用法: /maimai song <关键词>';
              return handleSearchSong(client, songCache, { keyword, limit: 5 });
            },
          },
          {
            name: 'bind',
            description: '绑定自己的好友码：/maimai bind <friend_code>',
            action: async (c) => {
              const fc = parseIntStrict(c.args[0]);
              if (!fc) return '用法: /maimai bind <好友码>';
              return handleBind(ctx, { friend_code: String(fc) }, c);
            },
          },
          {
            name: 'unbind',
            description: '解绑自己',
            action: async (c) => {
              const ok = await clearBoundFriendCode(ctx, c.platform, c.userId);
              return ok ? '已解绑' : '解绑失败';
            },
          },
        ],
      },
    );

    ctx.logger.info('[maimai] 斜杠指令已注册');
  }
}

// ===== 处理函数（工具与指令共用） =====

async function handleGetPlayer(
  ctx: Context,
  cfg: MaimaiConfig,
  client: MaimaiClient,
  args: Record<string, unknown>,
  callCtx: { sessionId: string; userId?: string; platform?: string },
): Promise<string> {
  const target = await resolveTarget(ctx, cfg, callCtx, args);
  if (target.source === 'none') return target.hint!;
  try {
    const player = await fetchPlayer(client, target);
    const head = target.hint ? `(${target.hint})\n` : '';
    return head + formatPlayer(player);
  } catch (err) {
    return `查询失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleGetBests(
  ctx: Context,
  cfg: MaimaiConfig,
  client: MaimaiClient,
  args: Record<string, unknown>,
  callCtx: { sessionId: string; userId?: string; platform?: string },
): Promise<string> {
  const target = await resolveTarget(ctx, cfg, callCtx, args);
  if (target.source === 'none') return target.hint!;
  // bests 接口仅支持 friend_code；若来源是 qq，先 lookup
  let friendCode = target.friend_code;
  try {
    if (!friendCode && target.qq) {
      const p = await client.getPlayerByQQ(target.qq);
      friendCode = p.friend_code;
    }
    if (!friendCode) return '无法解析好友码';
    const apOnly = args.ap_only === true;
    const topN = parseIntStrict(args.top_n) ?? 50;
    const bests = apOnly ? await client.getApBests(friendCode) : await client.getBests(friendCode);
    const head = target.hint ? `(${target.hint})\n` : '';
    return head + (apOnly ? '【AP B50】\n' : '') + formatBests(bests, { topN });
  } catch (err) {
    return `查询失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleGetRecents(
  ctx: Context,
  cfg: MaimaiConfig,
  client: MaimaiClient,
  args: Record<string, unknown>,
  callCtx: { sessionId: string; userId?: string; platform?: string },
): Promise<string> {
  const target = await resolveTarget(ctx, cfg, callCtx, args);
  if (target.source === 'none') return target.hint!;
  let friendCode = target.friend_code;
  try {
    if (!friendCode && target.qq) {
      const p = await client.getPlayerByQQ(target.qq);
      friendCode = p.friend_code;
    }
    if (!friendCode) return '无法解析好友码';
    const limit = Math.min(50, Math.max(1, parseIntStrict(args.limit) ?? 10));
    const scores = await client.getRecents(friendCode);
    return formatRecents(scores, limit);
  } catch (err) {
    return `查询失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleSearchSong(
  client: MaimaiClient,
  cache: { ref: SongIndex | null },
  args: Record<string, unknown>,
): Promise<string> {
  const keyword = String(args.keyword ?? '').trim();
  if (!keyword) return '请提供搜索关键词';
  const limit = Math.min(20, Math.max(1, parseIntStrict(args.limit) ?? 5));
  try {
    const idx = await loadSongIndex(client, cache);
    const matches = searchSongs(idx, keyword, limit);
    if (matches.length === 0) return `未找到匹配「${keyword}」的曲目`;
    const head = `🔍 共 ${matches.length} 条匹配 (关键词: ${keyword})`;
    return [head, ...matches.map(m => formatSongMatch(m, idx))].join('\n\n');
  } catch (err) {
    return `查询失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleBind(
  ctx: Context,
  args: Record<string, unknown>,
  callCtx: { userId?: string; platform?: string },
): Promise<string> {
  const fc = parseIntStrict(args.friend_code);
  if (!fc) return '请提供有效的好友码（数字）';
  const ok = await setBoundFriendCode(ctx, callCtx.platform, callCtx.userId, fc);
  if (!ok) return '绑定失败：记忆服务未提供 saveMetadata，或未识别到 platform:userId';
  return `已将 ${callCtx.platform}:${callCtx.userId} 绑定到好友码 ${fc}`;
}

// ===== 指令参数解析 =====

/**
 * 解析子指令的常见参数：
 *   - 一个纯数字 → friend_code
 *   - qq:数字     → qq
 */
function parseSubArgs(c: CommandContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of c.args) {
    if (a.startsWith('--')) continue;
    if (/^qq:\d+$/i.test(a)) {
      out.qq = a.slice(3);
    } else if (/^\d{3,}$/.test(a)) {
      if (out.friend_code === undefined) out.friend_code = a;
    }
  }
  return out;
}

function formatHelp(): string {
  return [
    '舞萌 DX 查分指令:',
    '  /maimai info [friend_code|qq:<qq>]   - 查询玩家信息',
    '  /maimai b50  [friend_code|qq:<qq>] [--ap]  - 查询 Best 50',
    '  /maimai recent [friend_code|qq:<qq>] [N]   - 最近 N 条游玩',
    '  /maimai song <关键词>                 - 搜索曲目（含别名）',
    '  /maimai bind <friend_code>            - 绑定自己的好友码',
    '  /maimai unbind                        - 解绑',
    '',
    '提示：绑定后，info/b50/recent 可省略参数；OneBot 私聊默认尝试以你的 QQ 查询。',
  ].join('\n');
}

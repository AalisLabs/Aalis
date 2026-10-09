#!/usr/bin/env node
// ============================================================
// create-aalis — 在新目录脚手架一个可运行的独立 Aalis 项目（纯 npm）
//
//   npm create aalis@latest my-bot                → 交互：对话模型（可当场粘贴 key）、接入平台、要不要长期语义记忆
//   npm create aalis@latest my-bot -- --advanced  → 另问模板档、记忆后端、embedding 与向量库
//   npm create aalis@latest my-bot -- --yes       → 非交互：上面几问全取默认
//   npm create aalis@latest my-bot -- --tier minimal --no-install
//
// 产出一个独立项目目录：package.json（依赖 @aalis/core + @aalis/runtime + 所选插件）、
// index.mjs（一行 startAalis 启动）、家目录 home/（aalis.config.yaml 与 secrets.yaml）、README、.gitignore，
// 随后自动 npm install，失败时按 npm 的报错写明是哪一类、怎么修。启动：cd my-bot && npm start。
//
// 默认装 standard 档的常用一套；本机有 Ollama（认 OLLAMA_HOST）时对话模型默认用它，零 key 可用。
// 所选插件即写入 dependencies，由 @aalis/runtime 的 node_modules 加载器在启动时发现并加载。
// ============================================================

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arch, argv, cwd, env, exit, platform, stderr, stdin, stdout, version } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/** 模板档：bare 只有 core 与 runtime，full 为全部官方插件 */
type Tier = 'bare' | 'minimal' | 'standard' | 'full';

// 基础设施 + agent 套件：minimal 起步的自洽依赖闭包（网关路由 → 指令/agent →
// 会话 → 权限 → 消息归档 + 跨会话历史）。会话服务提供会话协议与审批：没有它，需要确认的工具调用一律被拒。
// 对话模型、平台与记忆后端由提问选。钩子与贡献点由插件提供（core 不内置），
// gateway / agent / 指令等都 required 它们，缺了整个机器人挂起，故排在最前。
export const MINIMAL_BASE = [
  '@aalis/plugin-hooks',
  '@aalis/plugin-contributions',
  '@aalis/plugin-storage-local',
  '@aalis/plugin-process-local',
  '@aalis/plugin-gateway',
  '@aalis/plugin-commands',
  '@aalis/plugin-flow-control',
  '@aalis/plugin-agent',
  '@aalis/plugin-tools',
  '@aalis/plugin-prompt-budget',
  '@aalis/plugin-authority',
  '@aalis/plugin-session-manager',
  '@aalis/plugin-session-server',
  '@aalis/plugin-message-archive',
  '@aalis/plugin-memory-history',
];

// standard 在 minimal 之上增加的常用能力（人设 / 记忆增强 / 常用工具 / 调度套件 / 技能 / 会话增强 / 诊断）。
// 平台与语义记忆由提问选；联网搜索要 key，默认不装，需要时在插件市场装（full 档带它）。
export const STANDARD_EXTRA = [
  '@aalis/plugin-persona',
  '@aalis/plugin-memory-summary',
  '@aalis/plugin-user-profile',
  '@aalis/plugin-user-relation',
  '@aalis/plugin-file-reader',
  '@aalis/plugin-tool-system',
  '@aalis/plugin-tool-search',
  '@aalis/plugin-media',
  '@aalis/plugin-scheduler',
  '@aalis/plugin-cron-engine',
  '@aalis/plugin-trigger-policy',
  '@aalis/plugin-todo-list',
  '@aalis/plugin-checkpoint',
  '@aalis/plugin-skills',
  '@aalis/plugin-subtask',
  '@aalis/plugin-tool-session',
  '@aalis/plugin-doctor',
  '@aalis/plugin-mcp-client',
];

/** 一个选项：插件包名（模板档的选项是档名）与终端里显示的说明 */
export interface Option {
  name: string;
  label: string;
}

const DEEPSEEK = '@aalis/plugin-llm-deepseek';
const OLLAMA_LLM = '@aalis/plugin-llm-ollama';
const OPENAI_EMBEDDING = '@aalis/plugin-embedding-openai';
const OLLAMA_EMBEDDING = '@aalis/plugin-embedding-ollama';
const SQLITE = '@aalis/plugin-memory-sqlite';
const FLAT = '@aalis/plugin-vectorstore-flat';
const LANCEDB = '@aalis/plugin-vectorstore-lancedb';
const WEBUI = '@aalis/plugin-webui-server';
/** 语义记忆：向量记忆加一个 embedding 提供者与一个向量库 */
const SEMANTIC_MEMORY = '@aalis/plugin-memory-vector';
/** 语义记忆用 Ollama Embedding 时的模型：那个插件的默认值 */
const OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';

/** 对话模型：单选，多装几个以后在插件市场装 */
export const CHAT_MODELS: Option[] = [
  { name: DEEPSEEK, label: 'DeepSeek' },
  { name: '@aalis/plugin-llm-openai', label: 'OpenAI' },
  { name: OLLAMA_LLM, label: 'Ollama（本机运行，零 key）' },
];

export const PLATFORMS: Option[] = [
  { name: '@aalis/plugin-cli', label: 'CLI 终端' },
  { name: WEBUI, label: 'WebUI 管理界面' },
  { name: '@aalis/plugin-adapter-onebot', label: 'OneBot（QQ 等）' },
];
const DEFAULT_PLATFORMS = ['@aalis/plugin-cli', WEBUI];

export const MEMORY_BACKENDS: Option[] = [
  { name: SQLITE, label: 'SQLite（本地文件，推荐）' },
  { name: '@aalis/plugin-memory-inmemory', label: '内存（重启丢失）' },
  { name: '@aalis/plugin-memory-mongodb', label: 'MongoDB（需外部服务）' },
];

export const EMBEDDINGS: Option[] = [
  { name: OPENAI_EMBEDDING, label: 'OpenAI Embedding' },
  { name: OLLAMA_EMBEDDING, label: 'Ollama Embedding（本机运行，零 key）' },
];

export const VECTORSTORES: Option[] = [
  { name: FLAT, label: 'Flat（内置，零依赖）' },
  { name: LANCEDB, label: 'LanceDB（高性能）' },
];

const TIER_OPTIONS: Array<{ name: Tier; label: string }> = [
  { name: 'bare', label: 'bare：只装 core 与 runtime（完全自定义的起点）' },
  { name: 'minimal', label: 'minimal：最简对话实例（网关、Agent、权限、会话、对话模型、平台与记忆后端）' },
  {
    name: 'standard',
    label: 'standard：常用的一套（minimal 加人设、记忆增强、工具、调度、技能、诊断等，可选语义记忆）',
  },
  { name: 'full', label: 'full：全部已发布的官方插件（实时查 npm，含联网搜索）' },
];

// 要密钥的插件与它的键：提问时当场粘贴，没粘贴的写成空桩，由用户在 WebUI 或配置文件里填。直接写进
// home/aalis.config.yaml（home/ 不入库，见 renderGitignore），首次启动时宿主把密钥移进 secrets.yaml、配置里换成引用。
// 不走 `.env` + `${VAR}` 插值：配置文件本身已被 ignore，那一层纯属多余。
const KNOWN_CONFIG: Record<string, string[]> = {
  [DEEPSEEK]: ['apiKey'],
  '@aalis/plugin-llm-openai': ['apiKey'],
  [OPENAI_EMBEDDING]: ['apiKey'],
  '@aalis/plugin-websearch-serper': ['apiKey'],
};

/** 当场粘贴的密钥：插件 → 键 → 值 */
export type Keys = Record<string, Record<string, string>>;

/** minimal 与 standard 档里选的插件 */
export interface Picks {
  chat: string;
  platforms: string[];
  memory: string;
  /** 语义记忆（只在 standard 档）：不要时没有 */
  semantic?: { embedding: string; vectorstore: string };
}

/** 装哪些插件：full 档另带实时查到的官方插件（查不到为 null，回退离线表） */
export type Plan =
  | { tier: 'bare' }
  | { tier: 'full'; catalog: string[] | null }
  | { tier: 'minimal' | 'standard'; picks: Picks };

/** 语义记忆的 embedding：有 Ollama 可用（探到了，或对话模型选了它）时用它，零 key；否则用 OpenAI */
function embeddingFor(chat: string, ollama: boolean): string {
  return ollama || chat === OLLAMA_LLM ? OLLAMA_EMBEDDING : OPENAI_EMBEDDING;
}

/** 各问的默认答案（--yes、--tier 与回车）：探到 Ollama 时对话模型与语义记忆都用它，否则 DeepSeek、不装语义记忆 */
export function defaultPicks(tier: 'minimal' | 'standard', ollama: boolean): Picks {
  const chat = ollama ? OLLAMA_LLM : DEEPSEEK;
  const picks: Picks = { chat, platforms: [...DEFAULT_PLATFORMS], memory: SQLITE };
  if (tier === 'standard' && ollama) picks.semantic = { embedding: embeddingFor(chat, ollama), vectorstore: FLAT };
  return picks;
}

/**
 * 逐项提问：对话模型（要 key 的当场粘贴）、接入平台、要不要语义记忆（standard 档）；advanced 另问记忆后端、
 * embedding 与向量库。没有 LanceDB 预编译件的平台不列它
 */
export async function askPicks(
  p: Prompter,
  o: { tier: 'minimal' | 'standard'; advanced: boolean; ollama: boolean; lancedb: boolean },
): Promise<{ picks: Picks; keys: Keys }> {
  const keys: Keys = {};
  const paste = async (plugin: Option) => {
    for (const key of KNOWN_CONFIG[plugin.name] ?? []) {
      const value = await p.secret(`粘贴 ${plugin.label} 的 ${key}（输入不显示，回车跳过）`);
      if (value) keys[plugin.name] = { ...keys[plugin.name], [key]: value };
    }
  };
  const chat = await p.choose('对话模型', CHAT_MODELS, o.ollama ? OLLAMA_LLM : DEEPSEEK);
  await paste(chat);
  const platforms = await p.chooseMany('接入平台（可多选）', PLATFORMS, DEFAULT_PLATFORMS);
  const memory = o.advanced ? (await p.choose('记忆后端', MEMORY_BACKENDS, SQLITE)).name : SQLITE;
  const picks: Picks = { chat: chat.name, platforms, memory };
  if (
    o.tier === 'standard' &&
    (await p.confirm('要长期语义记忆吗？按意思找回很久以前聊过的内容，需要一个 embedding 模型', o.ollama))
  ) {
    const fallback = embeddingFor(chat.name, o.ollama);
    const embedding = o.advanced
      ? await p.choose('Embedding 提供者', EMBEDDINGS, fallback)
      : EMBEDDINGS.find(e => e.name === fallback)!;
    await paste(embedding);
    const stores = VECTORSTORES.filter(v => o.lancedb || v.name !== LANCEDB);
    const vectorstore = o.advanced ? (await p.choose('向量库', stores, FLAT)).name : FLAT;
    picks.semantic = { embedding: embedding.name, vectorstore };
  }
  return { picks, keys };
}

/** @lancedb/lancedb 带预编译件的平台（它 optionalDependencies 里的平台包）：别的平台装上也起不来 */
const LANCEDB_PLATFORMS = new Set(['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']);

export function lancedbSupported(os: string, cpu: string): boolean {
  return LANCEDB_PLATFORMS.has(`${os}-${cpu}`);
}

/** 要装的插件：档的基础集加所选，再带上伴生包。lancedb 为 false 时 full 档也不装 LanceDB */
export function pluginSet(plan: Plan, lancedb: boolean): Set<string> {
  const set = new Set<string>();
  if (plan.tier === 'full') {
    const options = [CHAT_MODELS, PLATFORMS, MEMORY_BACKENDS, EMBEDDINGS, VECTORSTORES].flat().map(o => o.name);
    for (const name of [...MINIMAL_BASE, ...STANDARD_EXTRA, SEMANTIC_MEMORY, ...options]) set.add(name);
    for (const name of plan.catalog ?? STATIC_OTHERS) set.add(name);
    if (!lancedb) set.delete(LANCEDB);
  } else if (plan.tier !== 'bare') {
    const { picks } = plan;
    for (const name of [...MINIMAL_BASE, picks.chat, ...picks.platforms, picks.memory]) set.add(name);
    if (plan.tier === 'standard') {
      for (const name of STANDARD_EXTRA) set.add(name);
      if (picks.semantic) for (const name of [SEMANTIC_MEMORY, ...Object.values(picks.semantic)]) set.add(name);
    }
  }
  // 选了 WebUI 后端就自动带上前端 + 安装引擎：
  // - webui-client：webui-server 仅托管前端静态资源，自身不含；缺它会 404
  //   「请安装 webui-client 插件」。它非运行时插件（无 apply），装上即被自动发现挂载。
  // - package-manager：否则市场页"安装"会报 503（webui-server 仅把它列为 dev 依赖）。
  if (set.has(WEBUI)) {
    set.add('@aalis/plugin-webui-client');
    set.add('@aalis/plugin-package-manager');
  }
  // 选了 code_runner 就自动带上 OS 沙箱实现：默认 sandbox.mode=auto，缺沙箱后端会 fail-closed
  // 拒绝执行代码，故把隔离实现一并装上（macOS sandbox-exec 自带；Linux 还需系统装 bubblewrap）。
  if (set.has('@aalis/plugin-tool-code-runner')) set.add('@aalis/plugin-code-sandbox-os');
  return set;
}

// ── Ollama ──────────────────────────────────────────────

/** 没设 OLLAMA_HOST 时探的地址 */
const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';

/**
 * OLLAMA_HOST（Ollama 自己的地址变量）→ 完整地址；没设返回 undefined，解析不了时抛错写明怎么改。
 * 与 Ollama 的解析一致：不写协议按 http、端口默认 11434；写了 http:// 或 https:// 的用协议的默认端口。
 */
export function ollamaHost(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  const href = withScheme ? value : `http://${value}`;
  if (!URL.canParse(href)) {
    throw new Error(
      `OLLAMA_HOST 的值「${value}」不是有效的地址：写成 主机:端口（如 127.0.0.1:11434）或完整地址（如 http://主机:端口）`,
    );
  }
  const url = new URL(href);
  if (!withScheme && !/:\d+$/.test(value.split('/')[0])) url.port = '11434';
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export interface OllamaProbe {
  base: string;
  /** 已拉的模型名，如 qwen3:8b */
  models: string[];
  /** 其中有对话模型 */
  chat: boolean;
}

/**
 * 探一下 Ollama：请求 /api/tags，1 秒拿不到像样的回应就当没有；同一个 1 秒里再逐个查 /api/show 报的能力。有没有对话模型与
 * Ollama 对话模型插件同一判据：能力里没有 completion 的（嵌入模型）不算，查不到能力的照对话模型算
 */
export async function probeOllama(base: string): Promise<OllamaProbe | null> {
  const signal = AbortSignal.timeout(1000);
  try {
    const r = await fetch(`${base}/api/tags`, { signal });
    if (!r.ok) return null;
    const body = (await r.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) return null;
    const models = body.models.map(m => (m as { name?: unknown }).name).filter(n => typeof n === 'string');
    const capabilities = await Promise.all(models.map(model => ollamaCapabilities(base, model, signal)));
    return { base, models, chat: capabilities.some(caps => !caps?.length || caps.includes('completion')) };
  } catch {
    return null;
  }
}

/** 一个模型在 /api/show 里报的能力；查不到时为 undefined */
async function ollamaCapabilities(base: string, model: string, signal: AbortSignal): Promise<unknown[] | undefined> {
  try {
    const r = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal,
    });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { capabilities?: unknown };
    return Array.isArray(body.capabilities) ? body.capabilities : undefined;
  } catch {
    return undefined;
  }
}

/** 用到 Ollama 时启动前要拉的模型：探不到时不知道里面有什么，照样提示 */
export function ollamaSteps(picks: Picks, probe: OllamaProbe | null): string[] {
  const models = probe?.models ?? [];
  const steps: string[] = [];
  if (picks.chat === OLLAMA_LLM && !probe?.chat) steps.push('ollama pull <对话模型名>    # 先拉一个对话模型');
  if (
    picks.semantic?.embedding === OLLAMA_EMBEDDING &&
    !models.some(m => m === OLLAMA_EMBEDDING_MODEL || m.startsWith(`${OLLAMA_EMBEDDING_MODEL}:`))
  ) {
    steps.push(`ollama pull ${OLLAMA_EMBEDDING_MODEL}    # 语义记忆用的 embedding 模型`);
  }
  return steps;
}

// ── live 插件目录（full 档枚举 + 版本号复用） ────────────
//
// 搜索走官方源（keyword:aalis-plugin，同市场页约定）；npm 镜像（淘宝等）多不支持
// search API，故这里固定官方源、可 --registry 覆盖。生成项目的 npm install 仍用
// 用户自己的 npm 配置（与此解耦）。离线/失败回退到静态 STATIC_OTHERS。
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const AALIS_KEYWORD = 'aalis-plugin';

/**
 * 装进依赖、但不是「可加载插件」的伴生包。
 *
 * webui-client 带的是 `aalis-interface` 关键词（纯前端静态资源，无 apply），
 * 加载器的关键词硬门不认它。计数时若不排除，README 与终端提示会比运行时实际
 * 加载数多一个（standard 档实测：README 说 41，运行时「发现 40 个插件」）。
 */
const NON_PLUGIN_COMPANIONS = new Set(['@aalis/plugin-webui-client']);

/** 依赖集里真正会被加载器发现的插件数 */
export function countPlugins(enabled: Iterable<string>): number {
  let n = 0;
  for (const pkg of enabled) if (!NON_PLUGIN_COMPANIONS.has(pkg)) n++;
  return n;
}

// 离线回退：已发布、但不在基础集与各问选项里的其他官方插件。
const STATIC_OTHERS = [
  'asr-openai',
  'asr-whisper-cpp',
  'draw',
  'image-sender',
  'maimai',
  'mcp-server',
  'office',
  'okx-trading',
  'tool-browser',
  'tool-code-runner',
  'tool-math',
  'tool-onebot',
  'websearch-serper',
  'workflow',
].map(s => `@aalis/plugin-${s}`);

interface CatalogEntry {
  name: string;
  official: boolean;
  /** npm search 返回的最新版本（用于脚手架逐包写 `^<最新>`，省一次单独查询） */
  version?: string;
}

/**
 * npm search 响应 → 插件目录条目。脚手架只收**可装功能插件**。
 *
 * 类型区分完全靠关键词，**不看包名**：检索用的是 `keywords:aalis-plugin`，而契约包带
 * `aalis-api`、前端带 `aalis-interface`、工具库带 `aalis-util`——它们根本不会出现在结果里。
 * 故此处不按包名剔除 `*-api` 与 `webui-client*`：关键词收敛（包按类型打词）之后那就是死代码，
 * 且按名判定会被改名打穿：`plugin-*-api` → `api-*` 之后 `/-api$/` 全部失配。
 *
 * 剩下的 `code-sandbox` 是**真功能插件**（带 aalis-plugin），排除理由与类型无关：它是被
 * code_runner 按需拉起的沙箱基建，不是用户「选功能」时该看到的条目。
 * 纯函数，便于单测。
 */
export function toPluginCatalog(data: {
  objects?: Array<{ package: { name: string; version?: string } }>;
}): CatalogEntry[] {
  return (
    (data.objects ?? [])
      // 短名仍带 `plugin-` 前缀（如 plugin-code-sandbox-os），故用非锚定匹配，勿用 /^code-sandbox/。
      .filter(o => !/code-sandbox/.test(o.package.name.replace(/^@[^/]+\//, '')))
      .map(o => ({
        name: o.package.name,
        official: o.package.name.startsWith('@aalis/'),
        version: o.package.version,
      }))
  );
}

// ── 输入校验（纯函数，便于单测；交互层在出错时重问而非静默吞）──────────

export type IndexParse = { ok: true; indices: number[] } | { ok: false; error: string };

/**
 * 解析「序号选择」输入：兼容逗号或空格分隔（"1,2" / "1, 2" / "1 2" 等价）。
 * 严格校验——任何非纯数字 token、越界、重复、或 exclusive 多选都返回 ok:false + 可读错误，
 * 由调用方重问；不做 parseInt 宽容 + filter 静默丢弃坏输入。
 * 空串视为 ok:[]（「空=默认/不选」的语义由调用方决定）。
 */
export function parseIndexSelection(raw: string, count: number, mode: 'multi' | 'exclusive'): IndexParse {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const indices: number[] = [];
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) {
      return { ok: false, error: `无法识别「${t}」：请只输入序号（如 1,2 或 1 2），不要含字母或符号。` };
    }
    const n = Number.parseInt(t, 10);
    if (n < 1 || n > count) return { ok: false, error: `序号 ${n} 超出范围（应在 1-${count}）。` };
    if (indices.includes(n)) return { ok: false, error: `序号 ${n} 重复了。` };
    indices.push(n);
  }
  if (mode === 'exclusive' && indices.length > 1) {
    return { ok: false, error: '这是单选，请只输入一个序号。' };
  }
  return { ok: true, indices };
}

/** 解析 yes/no 输入：空=默认；y/yes/true/1=真；n/no/false/0=假；其余=null（调用方重问）。与 create-aalis-plugin 的一致 */
export function parseYesNo(ans: string, def: boolean): boolean | null {
  const a = ans.trim().toLowerCase();
  if (a === '') return def;
  if (['y', 'yes', 'true', '1'].includes(a)) return true;
  if (['n', 'no', 'false', '0'].includes(a)) return false;
  return null;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * 校验是否为合法 npm 包名（生成项目/插件的 package.json `name`）。覆盖 npm 核心规则的常见子集：
 * 全小写、≤214 字符、无空格、不以 . 或 _ 开头、仅 url-safe 字符、可选 @scope/ 前缀。
 * 只用宽松正则（放行 MyBot / 全点名等）或只查非空不够，会生成无法 install/publish 的名字。
 */
export function validateNpmName(name: string): ValidationResult {
  if (!name) return { ok: false, error: '名称不能为空。' };
  if (name.length > 214) return { ok: false, error: '名称过长（>214 字符）。' };
  if (/\s/.test(name)) return { ok: false, error: '名称不能含空格。' };
  if (name !== name.toLowerCase()) return { ok: false, error: '名称必须全小写（npm 包名规则，如 my-bot）。' };
  let pkg = name;
  if (name.startsWith('@')) {
    const m = name.match(/^@([^/]+)\/(.+)$/);
    if (!m) return { ok: false, error: 'scope 包名格式应为 @scope/name。' };
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(m[1])) {
      return { ok: false, error: `scope「${m[1]}」非法（须以小写字母/数字开头，仅含 a-z 0-9 . _ -）。` };
    }
    pkg = m[2];
  }
  if (/^[._]/.test(pkg)) return { ok: false, error: '名称不能以 . 或 _ 开头。' };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(pkg)) {
    return { ok: false, error: '名称只能含小写字母、数字、- . _，且以字母或数字开头（如 my-bot）。' };
  }
  return { ok: true };
}

/** 最低 Node 版本：从这一版起，默认记忆后端用的 node:sqlite 不再打印实验特性警告。生成的项目同样写进 engines。 */
const MIN_NODE = '24.15.0';

/** 当前 Node（`process.version`，如 v24.15.0）够不够新；不够时写明需要的版本、当前版本与文档站升级一节的地址。 */
export function checkNodeVersion(current: string): ValidationResult {
  const have = current.slice(1).split('.').map(Number);
  const need = MIN_NODE.split('.').map(Number);
  // 逐段按数字比较，第一个不同的段定高低
  const at = need.findIndex((n, i) => have[i] !== n);
  if (at === -1 || have[at] > need[at]) return { ok: true };
  return {
    ok: false,
    error: [
      `Aalis 需要 Node.js ${MIN_NODE} 起，当前是 ${current}。`,
      `升级方法见 ${DOCS}/guide/first-run#upgrade-node`,
    ].join('\n'),
  };
}

// ── 终端提问 ──────────────────────────────────────────────

/** 终端提问：坏输入说明原因后重问，不静默接受 */
export interface Prompter {
  text(question: string, def: string, validate: (value: string) => ValidationResult): Promise<string>;
  /** 单选：回车取 def */
  choose<T extends Option>(title: string, options: readonly T[], def: string): Promise<T>;
  /** 多选，返回所选的 name：回车取 defs */
  chooseMany(title: string, options: readonly Option[], defs: readonly string[]): Promise<string[]>;
  confirm(question: string, def: boolean): Promise<boolean>;
  /** 不回显的输入（密钥）：回车跳过，得到空串 */
  secret(question: string): Promise<string>;
  close(): void;
}

export function createPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
  // 读密钥时关掉回显：终端模式下键入的字由 readline 写到输出，经这一层转发，关掉时丢弃
  let muted = false;
  const echo = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  // 不留输入历史：粘贴的密钥不能被上箭头翻出来
  const rl = createInterface({ input, output: echo, terminal: true, historySize: 0 });
  const say = (line: string) => output.write(`${line}\n`);
  const ask = async (question: string) => (await rl.question(question)).trim();

  async function select<T extends Option>(
    title: string,
    options: readonly T[],
    mode: 'multi' | 'exclusive',
    defs: readonly string[],
  ): Promise<T[]> {
    say(`\n${title}：`);
    for (const [i, o] of options.entries()) say(`  ${i + 1}. ${o.label}`);
    const defaults = options.filter(o => defs.includes(o.name));
    const shown = defaults.map(o => options.indexOf(o) + 1).join(',');
    const prompt =
      mode === 'exclusive' ? `选一个（序号，回车 = ${shown}）: ` : `选若干（逗号或空格分隔序号，回车 = ${shown}）: `;
    while (true) {
      const raw = await ask(prompt);
      if (raw === '') return defaults;
      const r = parseIndexSelection(raw, options.length, mode);
      if (r.ok) return r.indices.map(i => options[i - 1]);
      say(`  ⚠ ${r.error}`);
    }
  }

  return {
    async text(question, def, validate) {
      while (true) {
        const value = (await ask(`${question} (${def}): `)) || def;
        const r = validate(value);
        if (r.ok) return value;
        say(`  ⚠ ${r.error}`);
      }
    },
    choose: async (title, options, def) => (await select(title, options, 'exclusive', [def]))[0],
    chooseMany: async (title, options, defs) => (await select(title, options, 'multi', defs)).map(o => o.name),
    async confirm(question, def) {
      while (true) {
        const r = parseYesNo(await ask(`${question} (${def ? 'Y/n' : 'y/N'}): `), def);
        if (r !== null) return r;
        say('  ⚠ 请输入 y 或 n。');
      }
    },
    async secret(question) {
      // 提示在 question 里同步写出，之后才关回显
      const answer = rl.question(`${question}: `);
      muted = true;
      try {
        return (await answer).trim();
      } finally {
        muted = false;
        say('');
      }
    },
    close: () => rl.close(),
  };
}

// ── 版本 ──────────────────────────────────────────────────

/** 实时查 npm 的 aalis-plugin 目录；失败返回 null（调用方回退静态表）。 */
async function fetchCatalog(registry: string): Promise<CatalogEntry[] | null> {
  try {
    const base = registry.replace(/\/+$/, '') || DEFAULT_REGISTRY;
    const url = `${base}/-/v1/search?text=${encodeURIComponent(`keywords:${AALIS_KEYWORD}`)}&size=100`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return toPluginCatalog((await r.json()) as Parameters<typeof toPluginCatalog>[0]);
  } catch {
    return null;
  }
}

/** 查 {registry}/{pkg}/latest 的版本；失败返回 null（调用方回退 'latest'）。 */
async function fetchLatestVersion(registry: string, pkg: string): Promise<string | null> {
  try {
    const base = registry.replace(/\/+$/, '') || DEFAULT_REGISTRY;
    const r = await fetch(`${base}/${pkg}/latest`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { version?: unknown };
    return typeof j.version === 'string' ? j.version : null;
  } catch {
    return null;
  }
}

/**
 * 逐包解析写入生成项目 package.json 的版本范围（替代旧的硬编码 AALIS_RANGE 常量）：
 * - 插件优先复用 live catalog 已带的最新版（零额外请求）；
 * - core/runtime 及不在 catalog 的包，实时查 {registry}/{pkg}/latest；
 * - 任何解析失败的包回退 `'latest'`（npm install 时再取最新，自我修正，避免硬编码版本过时/无法跨 0.x 非统一版本）。
 * 解析得到的版本写成 `^<版本>`（与生态约定一致：0.x caret 锁次版本，每包各取自身最新）。
 */
async function resolveDepRanges(
  registry: string,
  names: readonly string[],
  catalog: CatalogEntry[] | null,
): Promise<Map<string, string>> {
  const fromCatalog = new Map<string, string>();
  for (const e of catalog ?? []) if (e.version) fromCatalog.set(e.name, e.version);
  const out = new Map<string, string>();
  await Promise.all(
    [...new Set(names)].map(async name => {
      const v = fromCatalog.get(name) ?? (await fetchLatestVersion(registry, name));
      out.set(name, v ? `^${v}` : 'latest');
    }),
  );
  return out;
}

// ── 生成的文件 ──────────────────────────────────────────────

const DOCS = 'https://aalis.acenyan.com';
const FIRST_RUN_URL = `${DOCS}/guide/first-run`;
const TROUBLESHOOTING_URL = `${DOCS}/guide/troubleshooting`;
/** webui-server 的默认监听地址与端口 */
const WEBUI_URL = 'http://127.0.0.1:3000';

function renderPackageJson(projectName: string, enabled: Set<string>, versions: Map<string, string>): string {
  const range = (n: string): string => versions.get(n) ?? 'latest';
  const deps: Record<string, string> = {
    '@aalis/core': range('@aalis/core'),
    '@aalis/runtime': range('@aalis/runtime'),
  };
  for (const n of [...enabled].sort()) deps[n] = range(n);
  return `${JSON.stringify(
    {
      name: projectName,
      version: '0.1.0',
      private: true,
      type: 'module',
      description: `${projectName} —— 基于 Aalis 的 AI 助手`,
      engines: { node: `>=${MIN_NODE}` },
      // 默认 dev 模式（startAalis 据 NODE_ENV!=='production' 判定）；
      // 生产部署用 `NODE_ENV=production node index.mjs`（Windows 用 set/$env:）。
      scripts: {
        start: 'node index.mjs',
      },
      dependencies: deps,
    },
    null,
    2,
  )}\n`;
}

function renderEntry(): string {
  return `import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAalis } from '@aalis/runtime';

// 从本目录的 node_modules 加载已装的 @aalis 插件。家目录（配置、密钥、数据、日志）缺省是本目录下的 home/，
// 设 AALIS_HOME 或用 npm start -- --home <目录> 可换到别处（npm 要在 -- 之后才把参数传给脚本）。
// 默认开启控制台彩色日志 + home/logs/latest.log 文件日志（无 TTY 时自动关闭染色）。
const here = dirname(fileURLToPath(import.meta.url));
startAalis({ appDir: here, defaultHome: join(here, 'home') }).catch(err => {
  console.error('Aalis 启动失败:', err);
  process.exit(1);
});
`;
}

// 只有 owner 能进的平台（本地终端 / 单 token WebUI）的平台档开箱给全部工具分组，无条件写：平台没装时这一层不起作用，
// 之后从市场装上即生效。多人平台（OneBot 等）不代开：带分组的工具默认不暴露，public 工具在群里的可达性靠这道分组闸
// （docs/concepts/security-model.md），由 owner 在平台档里按需列组。平台档是会话设置的一层，写在配置文档的 sessionConfig 里，
// 由 session-manager 读。runtime 的 `--init`（home.ts 的 initHome）写同样的平台档，两边由用例核完全相等。
const OWNER_PLATFORMS = ['cli', 'webui'];

/** Ollama 的两个插件：设了 OLLAMA_HOST 时写上它的 baseUrl */
const OLLAMA_PLUGINS = new Set([OLLAMA_LLM, OLLAMA_EMBEDDING]);

/** 写进配置的插件段：要密钥的插件写上粘贴的值（没粘贴的留空桩），设了 OLLAMA_HOST 时 Ollama 插件写上它 */
export function pluginSettings(
  enabled: Set<string>,
  keys: Keys,
  ollama?: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const name of [...enabled].sort()) {
    const stub = KNOWN_CONFIG[name]?.map(key => [key, keys[name]?.[key] ?? '']) ?? [];
    const host = ollama !== undefined && OLLAMA_PLUGINS.has(name) ? [['baseUrl', ollama]] : [];
    if (stub.length + host.length > 0) out[name] = Object.fromEntries([...stub, ...host]);
  }
  return out;
}

export function renderConfig(settings: Record<string, Record<string, string>>): string {
  const lines = ['name: Aalis', 'logLevel: info'];
  const configured = Object.keys(settings);
  if (configured.length > 0) {
    lines.push('plugins:');
    for (const name of configured) {
      lines.push(`  "${name}":`);
      // 值写成 JSON 字符串，同时也是合法的 YAML 双引号串：引号、反斜杠、冒号与 # 原样读回
      for (const [key, value] of Object.entries(settings[name])) lines.push(`    ${key}: ${JSON.stringify(value)}`);
    }
  } else {
    lines.push(
      '# 启用的插件用默认配置启动；需要密钥/地址的在下方 plugins 段填写（密钥在启动时移进同目录的 secrets.yaml，本处换成引用；home/ 已在 .gitignore 里，不入库）。',
    );
    lines.push('plugins: {}');
  }
  lines.push('sessionConfig:', '  platforms:');
  for (const platform of OWNER_PLATFORMS) lines.push(`    ${platform}:`, '      enabledToolGroups: ["*"]');
  lines.push('disabledPlugins: []');
  return `${lines.join('\n')}\n`;
}

function renderGitignore(): string {
  // 家目录 home/ 必须在列：配置、密钥与数据都在里面，入库即泄露。
  return `${['node_modules/', 'home/', '*.log', 'dist/'].join('\n')}\n`;
}

export function renderReadme(projectName: string, enabled: Set<string>): string {
  const hasWebui = enabled.has(WEBUI);
  return `# ${projectName}

基于 [Aalis](${DOCS}) 的 AI 助手项目，由 create-aalis 生成。

## 启动

\`\`\`bash
npm install        # 生成时跳过了安装的话
npm start
\`\`\`

- 第一次运行要做什么：${FIRST_RUN_URL}
- 装不上或起不来：${TROUBLESHOOTING_URL}

## 配置

- 家目录是 \`home/\`：配置、密钥、数据与日志都在里面（已在 \`.gitignore\` 里，不会入库）。设 \`AALIS_HOME\` 或用 \`npm start -- --home <目录>\` 可换到别处。
- 编辑 \`home/aalis.config.yaml\` 调整插件与参数。
- 密钥/令牌：填进 \`home/aalis.config.yaml\` 里该插件的段${hasWebui ? '，或启动后在 WebUI 插件区打开该插件填写' : ''}。启动时它们会被移进 \`home/secrets.yaml\`（0600），配置文件里换成引用；备份家目录时连同 \`secrets.yaml\` 一起备份。
${hasWebui ? `- WebUI 管理界面默认 ${WEBUI_URL} 。\n` : ''}
## 装更多插件

\`\`\`bash
npm install @aalis/plugin-<name>
\`\`\`

装好后重启实例${hasWebui ? '，或在 WebUI 插件区点「重新扫描」' : ''}，新插件才会加载。${hasWebui ? '也可以在 WebUI 的插件市场里搜索安装。' : ''}

> 启用集：${countPlugins(enabled)} 个插件。完整生态见 npm 上的 \`aalis-plugin\` 关键词。
`;
}

/** 结尾的「下一步」：进目录、Ollama 要拉的模型、启动，再点名还没填的密钥与去哪填 */
export function renderNextSteps(o: {
  dir: string;
  installed: boolean;
  enabled: Set<string>;
  keys: Keys;
  /** ollamaSteps 算出的命令 */
  ollama: string[];
  tier: Tier;
}): string {
  const hasWebui = o.enabled.has(WEBUI);
  const lines = ['下一步：', `  cd ${o.dir}${o.installed ? '' : ' && npm install'}`, ...o.ollama.map(s => `  ${s}`)];
  lines.push('  npm start');
  const unfilled = [...o.enabled]
    .sort()
    .flatMap(name => (KNOWN_CONFIG[name] ?? []).filter(key => !o.keys[name]?.[key]).map(key => `  ${name} 的 ${key}`));
  if (unfilled.length > 0) {
    lines.push(
      '',
      '还没填的密钥（填好之前对应的插件起不来）：',
      ...unfilled,
      `  填法：${hasWebui ? '启动后在 WebUI 插件区打开该插件填写，或' : ''}填进 home/aalis.config.yaml 里 plugins 下该插件的段`,
    );
  }
  // full 档另装了不少要手配的插件（OneBot 的连接、MongoDB 的 uri 等），上面点名的不是全部
  if (o.tier === 'full') {
    lines.push('', '其余要填凭据、地址或路径的插件：启动后在 WebUI 的「需要处理」里标待配置或失败，照着去配置。');
  }
  lines.push('', `第一次运行：${FIRST_RUN_URL}`);
  if (o.tier !== 'full') {
    lines.push(
      hasWebui
        ? '更多插件：启动后在 WebUI 的插件市场搜索安装；或 npm install @aalis/plugin-<名>，装好后重启实例或在插件区点「重新扫描」。'
        : '更多插件：npm install @aalis/plugin-<名>，装好后重启实例才会加载。',
    );
  }
  return `${lines.join('\n')}\n`;
}

// ── npm install ───────────────────────────────────────────

/** npm 失败的几类：与插件市场（plugin-package-manager 的 npmFailureKind）同一套，对账用例钉住 */
type InstallFailureKind = 'disk' | 'permission' | 'platform' | 'peer' | 'browser' | 'native' | 'missing' | 'network';

/**
 * npm install 失败的几类原因：按 npm 的报错认，第一行是原因，其余是修法。浏览器下载与原生编译先于网络认：它们的输出里也可能
 * 带网络错误码，但修法不同
 */
const INSTALL_FAILURES: Array<{
  kind: InstallFailureKind;
  match: RegExp;
  explain(stderr: string, found: RegExpExecArray): string[];
}> = [
  {
    kind: 'disk',
    match: /\bENOSPC\b/,
    explain: () => ['磁盘空间不够（ENOSPC）。', '腾出空间后再装。'],
  },
  {
    kind: 'permission',
    match: /\bEACCES\b/,
    explain: () => [
      '没有写入权限（EACCES）。',
      '不要用 sudo 重试：把项目目录与 npm 的缓存目录（npm config get cache 查看）改回当前用户所有，',
      '例如 sudo chown -R "$(whoami)" <目录>；报的是全局目录时，用 nvm 装的 Node，或 npm config set prefix ~/.npm-global。',
    ],
  },
  {
    kind: 'platform',
    match: /\bEBADPLATFORM\b/,
    explain: stderr => {
      const pkg = /Unsupported platform for (\S+?)@\d/.exec(stderr)?.[1] ?? '某个依赖';
      return [
        `依赖 ${pkg} 不支持这台机器的系统或 CPU 架构（EBADPLATFORM）。`,
        `加 --advanced 重新生成，换掉用到它的插件（npm ls ${pkg} 查是哪个）。`,
      ];
    },
  },
  {
    kind: 'peer',
    match: /\bERESOLVE\b/,
    explain: () => [
      'npm 解不开依赖版本（ERESOLVE）。',
      '新生成的项目里不该出现：请把上面的日志附进问题报告 https://github.com/AalisLabs/Aalis/issues',
    ],
  },
  {
    kind: 'browser',
    match: /Failed to set up (?:chrome|chrome-headless-shell|firefox)\b|node_modules[\\/]puppeteer\s*$/m,
    explain: () => [
      '下载浏览器失败：用到浏览器的插件装的时候要下载 Chrome。',
      '设镜像地址后重装：PUPPETEER_CHROME_DOWNLOAD_BASE_URL=<镜像地址> PUPPETEER_CHROME_HEADLESS_SHELL_DOWNLOAD_BASE_URL=<镜像地址> npm install；',
      '或先不装用到浏览器的插件：从 package.json 的 dependencies 删掉它们再 npm install（npm ls puppeteer 查是哪几个）。',
    ],
  },
  {
    kind: 'native',
    match: /gyp ERR!|node-gyp|prebuild-install/,
    explain: stderr => {
      const pkg =
        /^npm (?:error|ERR!) path \S*node_modules[\\/]((?:@[^\\/\s]+[\\/])?[^\\/\s]+)\s*$/m.exec(stderr)?.[1] ??
        '某个依赖';
      return [
        `原生模块 ${pkg} 编译失败：本机缺 C/C++ 编译工具。`,
        '装上编译工具后重装：macOS 执行 xcode-select --install；Linux 装 build-essential 与 python3；Windows 装 Visual Studio 的「使用 C++ 的桌面开发」。',
        `或加 --advanced 重新生成，换掉用到它的插件（npm ls ${pkg} 查是哪个）。`,
      ];
    },
  },
  {
    kind: 'missing',
    match: /\b(E404|ETARGET)\b/,
    explain: (_stderr, [, code]) => [
      `源上没有这个包或这个版本（${code}）。`,
      '核对包名与版本；用的是镜像源时，刚发布的版本可能还没同步，稍后重试或临时换回官方源：npm install --registry=https://registry.npmjs.org。',
    ],
  },
  {
    kind: 'network',
    match: /\b(ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/,
    explain: (_stderr, [, code]) => [
      `连不上 npm 源（${code}）。`,
      '检查网络与代理设置后重试；默认源不通时换一个：npm config set registry <源地址>，再 npm install。',
    ],
  },
];

/** 按先后认 npm 的报错：第一个对上的类别与匹配结果 */
function recognize(stderr: string) {
  for (const failure of INSTALL_FAILURES) {
    const found = failure.match.exec(stderr);
    if (found) return { failure, found };
  }
  return undefined;
}

/** npm 的报错认出是哪一类，认不出时为 undefined */
export function installFailureKind(stderr: string): InstallFailureKind | undefined {
  return recognize(stderr)?.failure.kind;
}

/** npm install 失败后给用户的说明：认得出的写明原因与修法，认不出的指向上面 npm 的报错；都带重试命令与日志位置 */
export function describeInstallFailure(stderr: string, dir: string): string {
  const known = recognize(stderr);
  const [reason, ...fixes] = known ? known.failure.explain(stderr, known.found) : ['原因见上面 npm 的报错。'];
  const log = /A complete log of this run can be found in:\s*(\S+)/.exec(stderr)?.[1];
  return [
    `npm install 失败：${reason}`,
    ...fixes.map(line => `  ${line}`),
    `重试：cd ${dir} && npm install`,
    ...(log ? [`npm 的完整日志：${log}`] : []),
    `安装排障：${TROUBLESHOOTING_URL}`,
  ].join('\n');
}

/** 失败时留下的 stderr 末尾长度：npm 的报错在最后，前面多是告警 */
const STDERR_TAIL = 32 * 1024;

/** 装依赖：npm 的输出照常显示在终端，stderr 另留末尾一段，失败时据此认原因 */
function npmInstall(dir: string): Promise<{ ok: true } | { ok: false; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn('npm', ['install'], {
      cwd: dir,
      stdio: ['inherit', 'inherit', 'pipe'],
      shell: process.platform === 'win32',
    });
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr.write(chunk);
      tail = (tail + chunk).slice(-STDERR_TAIL);
    });
    child.on('error', fail);
    child.on('close', code => done(code === 0 ? { ok: true } : { ok: false, stderr: tail }));
  });
}

// ── 主流程 ──────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  // 兼容两种写法：`--tier minimal` 与 `--tier=minimal`。后者若不认，TTY 下会静默掉回交互向导、
  // 非 TTY 下则撞上「检测到非交互式环境」退出——报错指向 TTY，把人往错误方向引。
  const eq = argv.find(a => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 带取值的 flag：紧随其后的一个 token 是它的值，不得再当位置参数。 */
const VALUE_FLAGS = new Set(['--tier', '--registry']);

/**
 * 取位置参数：跳过所有 flag，以及取值 flag 后面那个值。
 * `--tier full my-bot` 的位置参数只有 `my-bot`——否则 `full` 会被当项目名
 * （生成名为 full 的目录、静默丢弃用户传的名字），而 `--registry <url> my-bot`
 * 会拿 url 去校验包名并报「非法项目名」。
 */
export function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function fail(message: string): never {
  console.error(message);
  exit(1);
}

// 非交互终端（管道 / 某些 IDE 终端 / CI）下进交互模式会在 readline 遇 EOF 时静默空退
// （exit 0、无项目、无报错）。提前拦截并给可操作指引，避免「看着像用不了」。
const NON_TTY_GUIDE = [
  '',
  '检测到非交互式环境（stdin 不是 TTY），没法逐项提问。改用非交互的写法：',
  '  npm create aalis@latest <名> -- --yes             # 全取默认：探到本机 Ollama 时对话模型与语义记忆都用它，否则 DeepSeek、不装语义记忆；平台是 CLI 与 WebUI',
  '  npm create aalis@latest <名> -- --tier minimal    # 按某一档的默认装：bare、minimal、standard、full',
  '要密钥的插件，生成后在 home/aalis.config.yaml 里填，或启动后在 WebUI 插件区填。',
  '',
].join('\n');

/** 提问得到的答案：minimal 与 standard 档另有所选、粘贴的密钥与 Ollama 的探测结果 */
type Answers =
  | { projectName: string; tier: 'bare' | 'full' }
  | { projectName: string; tier: 'minimal' | 'standard'; picks: Picks; keys: Keys; probe: OllamaProbe | null };

async function collect(
  prompter: Prompter | undefined,
  o: { name?: string; tier?: Tier; advanced: boolean; force: boolean; host?: string; lancedb: boolean },
): Promise<Answers> {
  console.log('\n=== 创建 Aalis 项目 ===\n');
  const projectName =
    o.name ?? (prompter ? await prompter.text('项目目录名', 'my-aalis-bot', validateNpmName) : 'my-aalis-bot');
  const targetDir = resolve(cwd(), projectName);
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !o.force) {
    fail(`目录已存在且非空: ${targetDir}（加 --force 覆盖写入）`);
  }
  const advanced = prompter !== undefined && o.advanced;
  if (prompter && !advanced) {
    console.log('默认装常用的一套。要选模板档、记忆后端、embedding 或向量库，加 --advanced 重新运行。');
  }
  const tier =
    o.tier ?? (prompter && advanced ? (await prompter.choose('模板档', TIER_OPTIONS, 'standard')).name : 'standard');
  if (tier === 'bare' || tier === 'full') return { projectName, tier };

  const probe = await probeOllama(o.host ?? OLLAMA_DEFAULT);
  if (probe) {
    console.log(
      `探到 Ollama（${probe.base}），零 key 可用${probe.chat ? '' : '；里面还没有对话模型，启动前先 ollama pull 一个对话模型'}。`,
    );
  }
  const ollama = probe !== null;
  const { picks, keys } = prompter
    ? await askPicks(prompter, { tier, advanced, ollama, lancedb: o.lancedb })
    : { picks: defaultPicks(tier, ollama), keys: {} };
  return { projectName, tier, picks, keys, probe };
}

async function main(): Promise<void> {
  const node = checkNodeVersion(version);
  if (!node.ok) fail(node.error);

  const args = argv.slice(2);
  const tierFlag = argValue('--tier');
  const interactive = !(args.includes('--yes') || args.includes('-y') || tierFlag !== undefined);
  const registry = argValue('--registry') ?? DEFAULT_REGISTRY;
  const name = positionalArgs(args)[0];
  if (interactive && !stdin.isTTY) fail(NON_TTY_GUIDE);
  if (name !== undefined) {
    const r = validateNpmName(name);
    if (!r.ok) fail(`非法项目名「${name}」：${r.error}`);
  }
  const tier = tierFlag === undefined ? undefined : TIER_OPTIONS.find(t => t.name === tierFlag.toLowerCase())?.name;
  if (tierFlag !== undefined && tier === undefined) {
    fail(`未知模板档「${tierFlag}」，请输入 bare / minimal / standard / full。`);
  }
  let host: string | undefined;
  try {
    host = ollamaHost(env.OLLAMA_HOST);
  } catch (err) {
    fail((err as Error).message);
  }
  const lancedb = lancedbSupported(platform, arch);

  // 问完就关掉终端提问：装依赖期间 Ctrl+C 要照常能中止 npm
  const prompter = interactive ? createPrompter(stdin, stdout) : undefined;
  let answers: Answers;
  try {
    answers = await collect(prompter, {
      name,
      tier,
      advanced: args.includes('--advanced'),
      force: args.includes('--force'),
      host,
      lancedb,
    });
  } catch (err) {
    // 提问时按了 Ctrl+C：readline 随之关闭，没答完的那一问以 AbortError 结束。这时还没写任何文件
    if ((err as Error).name !== 'AbortError') throw err;
    console.error('\n已取消，没有生成任何文件。');
    exit(130);
  } finally {
    prompter?.close();
  }
  const { projectName } = answers;
  const chosen = answers.tier === 'minimal' || answers.tier === 'standard' ? answers : undefined;
  const keys = chosen?.keys ?? {};

  // 插件目录：full 档用它枚举全部官方插件；非 bare 档也复用其版本号，省去逐包查询。
  const catalog = answers.tier === 'bare' ? null : await fetchCatalog(registry);
  if (!catalog && answers.tier === 'full') console.warn('（无法连接 npm，full 档回退离线静态表）');
  const plan: Plan =
    answers.tier === 'full'
      ? { tier: 'full', catalog: catalog ? catalog.filter(e => e.official).map(e => e.name) : null }
      : chosen
        ? { tier: chosen.tier, picks: chosen.picks }
        : { tier: 'bare' };
  const enabled = pluginSet(plan, lancedb);

  const targetDir = resolve(cwd(), projectName);
  mkdirSync(targetDir, { recursive: true });
  // 逐包解析当前最新版本（复用 catalog；core/runtime 实时查；失败回退 latest）
  const versions = await resolveDepRanges(registry, ['@aalis/core', '@aalis/runtime', ...enabled], catalog);
  writeFileSync(resolve(targetDir, 'package.json'), renderPackageJson(projectName, enabled, versions), 'utf-8');
  writeFileSync(resolve(targetDir, 'index.mjs'), renderEntry(), 'utf-8');
  // 家目录：配置文件存在即算初始化过（runtime 的判据），目录与两个文件都收紧权限
  const homeDir = resolve(targetDir, 'home');
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(homeDir, 'secrets.yaml'), '', { encoding: 'utf-8', mode: 0o600 });
  writeFileSync(resolve(homeDir, 'aalis.config.yaml'), renderConfig(pluginSettings(enabled, keys, host)), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  writeFileSync(resolve(targetDir, '.gitignore'), renderGitignore(), 'utf-8');
  writeFileSync(resolve(targetDir, 'README.md'), renderReadme(projectName, enabled), 'utf-8');
  console.log(`\n✓ 已生成项目: ${targetDir}（启用 ${countPlugins(enabled)} 个插件）`);

  const install = !args.includes('--no-install');
  if (install) {
    console.log('\n正在 npm install（可能需要几分钟）…\n');
    const result = await npmInstall(targetDir);
    if (!result.ok) fail(`\n${describeInstallFailure(result.stderr, projectName)}`);
  }
  const ollama = chosen ? ollamaSteps(chosen.picks, chosen.probe) : [];
  console.log(
    `\n${renderNextSteps({ dir: projectName, installed: install, enabled, keys, ollama, tier: answers.tier })}`,
  );
}

// 仅在作为 CLI 直接执行时运行 main；被 import（单测纯函数）时不自动跑。
// 用 realpath 比较两侧：`npm create aalis` 经 .bin 软链调用时 argv[1] 是软链路径，
// 直接比 import.meta.url 会不相等导致 main() 静默不跑（Bug：交互界面进不来）。
let isCliEntry = false;
try {
  isCliEntry = !!argv[1] && realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* 非文件入口（REPL/eval 等）：保持 false，不自动运行 */
}
if (isCliEntry) {
  main().catch(err => {
    console.error(err);
    exit(1);
  });
}

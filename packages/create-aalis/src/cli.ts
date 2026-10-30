#!/usr/bin/env node
// ============================================================
// create-aalis — 在新目录脚手架一个可运行的独立 Aalis 项目（纯 npm）
//
//   npm create aalis@latest my-bot                → 交互：对话模型（可当场粘贴 key）、接入平台、要不要长期语义记忆
//   npm create aalis@latest my-bot -- --advanced  → 另问模板档、记忆后端、embedding 与向量库
//   npm create aalis@latest my-bot -- --yes       → 非交互：上面几问全取默认
//   npm create aalis@latest my-bot -- --tier minimal --no-install
//   npm create aalis@latest my-bot -- --yes --lang zh-CN,en → 指定 Aalis 的语言列表（安装界面也按它显示）
//
// 产出一个独立项目目录：package.json（依赖 @aalis/core + @aalis/runtime + 所选插件）、
// index.mjs（一行 startAalis 启动）、家目录 home/（aalis.config.yaml 与 secrets.yaml）、README、.gitignore，
// 随后自动 npm install，失败时按 npm 的报错写明是哪一类、怎么修。启动：cd my-bot && npm start。
//
// 默认装 standard 档的常用一套；本机有 Ollama（认 OLLAMA_HOST）时对话模型默认用它，零 key 可用。
// 所选插件即写入 dependencies，由 @aalis/runtime 的 node_modules 加载器在启动时发现并加载。
// 终端里的文字取自本包的字典（中文、英文），按系统语言或 --lang 显示；生成的文件按安装界面的语言写。
// ============================================================

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arch, argv, cwd, env, exit, platform, stderr, stdin, stdout, version } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  matchLanguage,
  normalizeLanguages,
  pickLanguage,
  resolveText,
  selfName,
  TextError,
  type TextRef,
  textLines,
  textOf,
} from '@aalis/schema-i18n';
import { t } from './texts.js';

/** 模板档：bare 只有 core 与 runtime，full 为全部官方插件 */
type Tier = 'bare' | 'minimal' | 'standard' | 'full';

// 基础设施 + agent 套件：minimal 起步的自洽依赖闭包（网关路由 → 指令/agent →
// 会话 → 权限 → 消息归档 + 跨会话历史）。会话服务提供会话协议与审批：没有它，需要确认的工具调用一律被拒。
// 对话模型、平台与记忆后端由提问选。钩子与贡献点由插件提供（core 不内置），
// gateway / agent / 指令等都 required 它们，缺了整个机器人挂起，故排在最前。多语言让各出口按读者的语言显示，没装时一律显示原文。
export const MINIMAL_BASE = [
  '@aalis/plugin-hooks',
  '@aalis/plugin-contributions',
  '@aalis/plugin-i18n',
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
  '@aalis/plugin-session-settings',
  '@aalis/plugin-session-server',
  '@aalis/plugin-message-archive',
  '@aalis/plugin-memory-history',
];

// standard 在 minimal 之上增加的常用能力（人设 / 记忆增强 / 常用工具 / 调度套件 / 技能 / 会话增强 / 诊断）。
// 平台与语义记忆由提问选；联网搜索要 key，默认不装，需要时在插件市场装（full 档带它）。
// 触及签发凭据，接线后读写文件、执行命令经它，与系统工具同在这一档。
// 聊天审批让 owner 在与她的 IM 私聊里批准她经同一个机器人账号要做的事（群里发起的也推到这里），没选 IM 平台时它不接入。
export const STANDARD_EXTRA = [
  '@aalis/plugin-persona',
  '@aalis/plugin-memory-summary',
  '@aalis/plugin-user-profile',
  '@aalis/plugin-user-relation',
  '@aalis/plugin-file-reader',
  '@aalis/plugin-tool-system',
  '@aalis/plugin-reach',
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
  '@aalis/plugin-chat-approval',
];

/** 终端里显示的文字：字典里的句子按显示语言渲染，品牌名、包名与命令这类原样 */
type Shown = string | TextRef;

/** 按显示语言取字符串 */
function shown(text: Shown, language: UiLanguage): string {
  return typeof text === 'string' ? text : resolveText(text, [language]);
}

/** 一个选项：插件包名（模板档的选项是档名）与终端里显示的说明 */
export interface Option {
  name: string;
  label: Shown;
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
  { name: OLLAMA_LLM, label: t('localNoKey', { name: 'Ollama' }) },
];

export const PLATFORMS: Option[] = [
  { name: '@aalis/plugin-cli', label: t('platformCli') },
  { name: WEBUI, label: t('platformWebui') },
  { name: '@aalis/plugin-adapter-onebot', label: t('platformOnebot') },
];
const DEFAULT_PLATFORMS = ['@aalis/plugin-cli', WEBUI];

export const MEMORY_BACKENDS: Option[] = [
  { name: SQLITE, label: t('memorySqlite') },
  { name: '@aalis/plugin-memory-inmemory', label: t('memoryInMemory') },
  { name: '@aalis/plugin-memory-mongodb', label: t('memoryMongodb') },
];

export const EMBEDDINGS: Option[] = [
  { name: OPENAI_EMBEDDING, label: 'OpenAI Embedding' },
  { name: OLLAMA_EMBEDDING, label: t('localNoKey', { name: 'Ollama Embedding' }) },
];

export const VECTORSTORES: Option[] = [
  { name: FLAT, label: t('vectorstoreFlat') },
  { name: LANCEDB, label: t('vectorstoreLancedb') },
];

const TIER_OPTIONS: Array<{ name: Tier; label: TextRef }> = [
  { name: 'bare', label: t('tierBare') },
  { name: 'minimal', label: t('tierMinimal') },
  { name: 'standard', label: t('tierStandard') },
  { name: 'full', label: t('tierFull') },
];

// ── 语言 ──────────────────────────────────────────────────

/** 安装界面的语言：本包字典有的语言（原文与译文） */
const UI_LANGUAGES = ['zh-CN', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** 第一方插件提供的语言：第一方字典都是原文 zh-CN、带 en */
const FIRST_PARTY_LANGUAGES = ['zh-CN', 'en'];

/** 按读者语言显示的插件：这批插件里有它时才排语言列表、写它的配置段 */
const I18N = '@aalis/plugin-i18n';

/**
 * 识别系统语言：Node 的 Intl 默认 locale（跟 LANG），规范化；认不出（und）时按 en-US。
 * 建项目时取一次：安装界面的语言、默认的语言列表与找语言包都按它
 */
export function systemLanguage(): string {
  const [tag] = normalizeLanguages([Intl.DateTimeFormat().resolvedOptions().locale]);
  return tag === undefined || tag.split('-')[0] === 'und' ? 'en-US' : tag;
}

/** --lang 的值：逗号分隔的语言列表，每项是认得的语言标签（判据同 plugin-i18n），规范化、去重；不合法时写明是哪一项 */
export function parseLanguages(raw: string): { ok: true; languages: string[] } | { ok: false; error: TextRef } {
  const languages: string[] = [];
  for (const item of raw.split(',').map(part => part.trim())) {
    const [tag] = normalizeLanguages([item]);
    if (tag === undefined) return { ok: false, error: t('badLanguage', { item }) };
    if (!languages.includes(tag)) languages.push(tag);
  }
  return { ok: true, languages };
}

/** 安装界面的语言：语言列表里第一个本包字典有的语言，都没有时按系统语言，再没有时为英文 */
export function uiLanguage(system: string, languages: readonly string[] = []): UiLanguage {
  const at = pickLanguage([...languages, system], UI_LANGUAGES);
  return at === undefined ? 'en' : UI_LANGUAGES[at];
}

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
      const value = await p.secret(t('pasteKey', { plugin: plugin.label, key }));
      if (value) keys[plugin.name] = { ...keys[plugin.name], [key]: value };
    }
  };
  const chat = await p.choose(t('chatTitle'), CHAT_MODELS, o.ollama ? OLLAMA_LLM : DEEPSEEK);
  await paste(chat);
  const platforms = await p.chooseMany(t('platformsTitle'), PLATFORMS, DEFAULT_PLATFORMS);
  const memory = o.advanced ? (await p.choose(t('memoryTitle'), MEMORY_BACKENDS, SQLITE)).name : SQLITE;
  const picks: Picks = { chat: chat.name, platforms, memory };
  if (o.tier === 'standard' && (await p.confirm(t('semanticQuestion'), o.ollama))) {
    const fallback = embeddingFor(chat.name, o.ollama);
    const embedding = o.advanced
      ? await p.choose(t('embeddingTitle'), EMBEDDINGS, fallback)
      : EMBEDDINGS.find(e => e.name === fallback)!;
    await paste(embedding);
    const stores = VECTORSTORES.filter(v => o.lancedb || v.name !== LANCEDB);
    const vectorstore = o.advanced ? (await p.choose(t('vectorstoreTitle'), stores, FLAT)).name : FLAT;
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
  if (!URL.canParse(href)) throw new TextError(t('badOllamaHost', { value }));
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

/** 用到 Ollama 时启动前要拉的模型（命令带说明）：探不到时不知道里面有什么，照样提示 */
export function ollamaSteps(picks: Picks, probe: OllamaProbe | null): TextRef[] {
  const models = probe?.models ?? [];
  const steps: TextRef[] = [];
  if (picks.chat === OLLAMA_LLM && !probe?.chat) steps.push(t('pullChat'));
  if (
    picks.semantic?.embedding === OLLAMA_EMBEDDING &&
    !models.some(m => m === OLLAMA_EMBEDDING_MODEL || m.startsWith(`${OLLAMA_EMBEDDING_MODEL}:`))
  ) {
    steps.push(t('pullEmbedding', { model: OLLAMA_EMBEDDING_MODEL }));
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
  'paper',
  'publish-review',
  'remote-agent-cursor',
  'tool-browser',
  'tool-code-runner',
  'tool-math',
  'tool-onebot',
  'usage-stats',
  'websearch-serper',
  'workflow',
  'works-site',
].map(s => `@aalis/plugin-${s}`);

interface CatalogEntry {
  name: string;
  official: boolean;
}

/** 检索结果里的一个包 */
interface Found {
  package: { name: string; keywords?: string[] };
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
export function toPluginCatalog(data: { objects?: Array<{ package: { name: string } }> }): CatalogEntry[] {
  return (
    (data.objects ?? [])
      // 短名仍带 `plugin-` 前缀（如 plugin-code-sandbox-os），故用非锚定匹配，勿用 /^code-sandbox/。
      .filter(o => !/code-sandbox/.test(o.package.name.replace(/^@[^/]+\//, '')))
      .map(o => ({
        name: o.package.name,
        official: o.package.name.startsWith('@aalis/'),
      }))
  );
}

// ── 输入校验（纯函数，便于单测；交互层在出错时重问而非静默吞）──────────

export type IndexParse = { ok: true; indices: number[] } | { ok: false; error: TextRef };

/**
 * 解析「序号选择」输入：兼容逗号或空格分隔（"1,2" / "1, 2" / "1 2" 等价）。
 * 严格校验——任何非纯数字 token、越界、重复、或 exclusive 多选都返回 ok:false + 可读错误，
 * 由调用方重问；不做 parseInt 宽容 + filter 静默丢弃坏输入。
 * 空串视为 ok:[]（「空=默认/不选」的语义由调用方决定）。
 */
export function parseIndexSelection(raw: string, count: number, mode: 'multi' | 'exclusive'): IndexParse {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const indices: number[] = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) return { ok: false, error: t('badToken', { token }) };
    const n = Number.parseInt(token, 10);
    if (n < 1 || n > count) return { ok: false, error: t('outOfRange', { n, count }) };
    if (indices.includes(n)) return { ok: false, error: t('duplicate', { n }) };
    indices.push(n);
  }
  if (mode === 'exclusive' && indices.length > 1) return { ok: false, error: t('singleChoice') };
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

export type ValidationResult = { ok: true } | { ok: false; error: TextRef };

/**
 * 校验是否为合法 npm 包名（生成项目/插件的 package.json `name`）。覆盖 npm 核心规则的常见子集：
 * 全小写、≤214 字符、无空格、不以 . 或 _ 开头、仅 url-safe 字符、可选 @scope/ 前缀。
 * 只用宽松正则（放行 MyBot / 全点名等）或只查非空不够，会生成无法 install/publish 的名字。
 */
export function validateNpmName(name: string): ValidationResult {
  if (!name) return { ok: false, error: t('nameEmpty') };
  if (name.length > 214) return { ok: false, error: t('nameTooLong') };
  if (/\s/.test(name)) return { ok: false, error: t('nameSpace') };
  if (name !== name.toLowerCase()) return { ok: false, error: t('nameUppercase') };
  let pkg = name;
  if (name.startsWith('@')) {
    const m = name.match(/^@([^/]+)\/(.+)$/);
    if (!m) return { ok: false, error: t('scopeFormat') };
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(m[1])) return { ok: false, error: t('scopeInvalid', { scope: m[1] }) };
    pkg = m[2];
  }
  if (/^[._]/.test(pkg)) return { ok: false, error: t('nameLeadingDot') };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(pkg)) return { ok: false, error: t('nameChars') };
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
    error: textLines([
      t('nodeTooOld', { need: MIN_NODE, current }),
      t('upgradeNode', { url: `${DOCS}/guide/first-run#upgrade-node` }),
    ]),
  };
}

// ── 终端提问 ──────────────────────────────────────────────

/** 终端提问：坏输入说明原因后重问，不静默接受。提问、选项与提示按 language 显示 */
export interface Prompter {
  /** 显示语言：选完安装界面的语言后改成那一种 */
  language: UiLanguage;
  text(question: Shown, def: string, validate: (value: string) => ValidationResult): Promise<string>;
  /** 单选：回车取 def */
  choose<T extends Option>(title: Shown, options: readonly T[], def: string): Promise<T>;
  /** 多选，返回所选的 name：回车取 defs */
  chooseMany(title: Shown, options: readonly Option[], defs: readonly string[]): Promise<string[]>;
  /** 排序，返回全部 name：输入的序号排在前面，没输入的照原顺序接在后面（只排序不删除）；回车照原顺序 */
  order(title: Shown, options: readonly Option[]): Promise<string[]>;
  confirm(question: Shown, def: boolean): Promise<boolean>;
  /** 不回显的输入（密钥）：回车跳过，得到空串 */
  secret(question: Shown): Promise<string>;
  close(): void;
}

export function createPrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  language: UiLanguage,
): Prompter {
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
  const show = (text: Shown) => shown(text, prompter.language);
  const say = (line: Shown) => output.write(`${show(line)}\n`);
  const ask = async (question: Shown) => (await rl.question(show(question))).trim();
  const warn = (error: TextRef) => say(t('warning', { error }));

  /** 列出选项，按序号读一组；坏输入说明原因后重问 */
  async function pick<T extends Option>(
    title: Shown,
    options: readonly T[],
    mode: 'multi' | 'exclusive',
    prompt: Shown,
  ): Promise<T[] | undefined> {
    say(`\n${show(t('optionsTitle', { title }))}`);
    for (const [i, o] of options.entries()) say(`  ${i + 1}. ${show(o.label)}`);
    while (true) {
      const raw = await ask(prompt);
      if (raw === '') return undefined;
      const r = parseIndexSelection(raw, options.length, mode);
      if (r.ok) return r.indices.map(i => options[i - 1]);
      warn(r.error);
    }
  }

  async function select<T extends Option>(
    title: Shown,
    options: readonly T[],
    mode: 'multi' | 'exclusive',
    defs: readonly string[],
  ): Promise<T[]> {
    const defaults = options.filter(o => defs.includes(o.name));
    const shownDefaults = defaults.map(o => options.indexOf(o) + 1).join(',');
    const prompt = t(mode === 'exclusive' ? 'chooseOne' : 'chooseMany', { shown: shownDefaults });
    return (await pick(title, options, mode, prompt)) ?? defaults;
  }

  const prompter: Prompter = {
    language,
    async text(question, def, validate) {
      while (true) {
        const value = (await ask(`${show(question)} (${def}): `)) || def;
        const r = validate(value);
        if (r.ok) return value;
        warn(r.error);
      }
    },
    choose: async (title, options, def) => (await select(title, options, 'exclusive', [def]))[0],
    chooseMany: async (title, options, defs) => (await select(title, options, 'multi', defs)).map(o => o.name),
    async order(title, options) {
      const first = (await pick(title, options, 'multi', t('orderPrompt'))) ?? [];
      return [...first, ...options.filter(o => !first.includes(o))].map(o => o.name);
    },
    async confirm(question, def) {
      while (true) {
        const r = parseYesNo(await ask(`${show(question)} (${def ? 'Y/n' : 'y/N'}): `), def);
        if (r !== null) return r;
        warn(t('yesOrNo'));
      }
    },
    async secret(question) {
      // 提示在 question 里同步写出，之后才关回显
      const answer = rl.question(`${show(question)}: `);
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
  return prompter;
}

// ── 版本 ──────────────────────────────────────────────────

/** 按关键词检索源上的包；失败返回 null */
async function search(registry: string, keyword: string): Promise<Found[] | null> {
  try {
    const base = registry.replace(/\/+$/, '') || DEFAULT_REGISTRY;
    const url = `${base}/-/v1/search?text=${encodeURIComponent(`keywords:${keyword}`)}&size=100`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return ((await r.json()) as { objects?: Found[] }).objects ?? [];
  } catch {
    return null;
  }
}

/** 实时查 npm 的 aalis-plugin 目录；失败返回 null（调用方回退静态表）。 */
async function fetchCatalog(registry: string): Promise<CatalogEntry[] | null> {
  const objects = await search(registry, AALIS_KEYWORD);
  return objects && toPluginCatalog({ objects });
}

/**
 * 按语言找语言包：关键词 aalis-lang-<小写标签>，先按完整标签、再按基础语言（ja-JP 先找 aalis-lang-ja-jp，再找 aalis-lang-ja），
 * 只收确实带这个关键词的包。回找到的包名与关键词对应的语言，没找到时包名为空；检索失败回 null
 */
async function findLanguagePacks(registry: string, tag: string): Promise<{ language: string; names: string[] } | null> {
  const base = new Intl.Locale(tag).language;
  for (const language of tag === base ? [tag] : [tag, base]) {
    const keyword = `aalis-lang-${language.toLowerCase()}`;
    const found = await search(registry, keyword);
    if (!found) return null;
    const names = found.filter(o => o.package.keywords?.includes(keyword)).map(o => o.package.name);
    if (names.length > 0) return { language, names };
  }
  return { language: tag, names: [] };
}

/** 没找到语言包时的提示：检索失败写连不上；源是官方源时只说没有，别的源另提示它可能不支持检索 */
export function packSearchMiss(registry: string, failed: boolean, language: { name: string; tag: string }): TextRef {
  if (failed) return t('packSearchFailed', { registry, ...language });
  const official = (registry.replace(/\/+$/, '') || DEFAULT_REGISTRY) === DEFAULT_REGISTRY;
  return t(official ? 'packSearchEmpty' : 'packSearchEmptyMirror', { registry, ...language });
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
 * 逐包解析写入生成项目 package.json 的版本范围：一律实时查 {registry}/{pkg}/latest。检索结果只用来列出有哪些插件，
 * 它带的版本来自搜索索引，发布后可能还是旧的，写进 `^<旧版>` 会把项目锁在旧次版本上。
 * 解析失败的包回退 `'latest'`（npm install 时再取最新）。解析得到的版本写成 `^<版本>`（0.x caret 锁次版本，每包各取自身最新）。
 */
async function resolveDepRanges(registry: string, names: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    [...new Set(names)].map(async name => {
      const v = await fetchLatestVersion(registry, name);
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

/** 生成的文件里按安装界面的语言写的说明（普通字符串，不经字典：生成的文件没有读者语言一说） */
interface Copy {
  /** package.json 的 description */
  description(projectName: string): string;
  /** 入口 index.mjs 的注释 */
  entry: string;
  /** 配置里没有插件段时 plugins 上方的注释 */
  config: string;
  readme(o: { projectName: string; hasWebui: boolean; plugins: number }): string;
}

const COPY: Record<UiLanguage, Copy> = {
  'zh-CN': {
    description: projectName => `${projectName} —— 基于 Aalis 的 AI 助手`,
    entry: `// 从本目录的 node_modules 加载已装的 @aalis 插件。家目录（配置、密钥、数据、日志）缺省是本目录下的 home/，
// 设 AALIS_HOME 或用 npm start -- --home <目录> 可换到别处（npm 要在 -- 之后才把参数传给脚本）。
// 默认开启控制台彩色日志 + home/logs/latest.log 文件日志（无 TTY 时自动关闭染色）。`,
    config:
      '# 启用的插件用默认配置启动；需要密钥/地址的在下方 plugins 段填写（密钥在启动时移进同目录的 secrets.yaml，本处换成引用；home/ 已在 .gitignore 里，不入库）。',
    readme: ({ projectName, hasWebui, plugins }) => `# ${projectName}

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

> 启用集：${plugins} 个插件。完整生态见 npm 上的 \`aalis-plugin\` 关键词。
`,
  },
  en: {
    description: projectName => `${projectName} — an AI assistant based on Aalis`,
    entry: `// Loads the installed @aalis plugins from this directory's node_modules. The home directory (config, secrets, data, logs)
// defaults to home/ here; set AALIS_HOME or use npm start -- --home <directory> to move it (npm passes arguments to the script only after --).
// Colored console logs and the home/logs/latest.log file log are on by default (coloring turns off without a TTY).`,
    config:
      '# Enabled plugins start with their default configuration; fill in keys and addresses in the plugins section below (on start, keys move into secrets.yaml in this directory and are replaced by references here; home/ is in .gitignore and not committed).',
    readme: ({ projectName, hasWebui, plugins }) => `# ${projectName}

An AI assistant project based on [Aalis](${DOCS}), generated by create-aalis.

## Start

\`\`\`bash
npm install        # if installing was skipped when generating
npm start
\`\`\`

- What to do on the first run: ${FIRST_RUN_URL}
- If it fails to install or start: ${TROUBLESHOOTING_URL}

## Configuration

- The home directory is \`home/\`: configuration, secrets, data and logs all live there (it is in \`.gitignore\` and not committed). Set \`AALIS_HOME\` or use \`npm start -- --home <directory>\` to move it elsewhere.
- Edit \`home/aalis.config.yaml\` to adjust plugins and settings.
- Keys and tokens: fill them into the plugin's section in \`home/aalis.config.yaml\`${hasWebui ? ', or open the plugin in the WebUI plugin area after starting' : ''}. On start they are moved into \`home/secrets.yaml\` (0600) and replaced by references in the config file; back up \`secrets.yaml\` together with the home directory.
${hasWebui ? `- The WebUI admin console is at ${WEBUI_URL} by default.\n` : ''}
## More plugins

\`\`\`bash
npm install @aalis/plugin-<name>
\`\`\`

New plugins load after you restart the instance${hasWebui ? ' or use Rescan plugin folders in the WebUI plugin area' : ''}.${hasWebui ? ' You can also search for and install them in the WebUI plugin market.' : ''}

> Enabled plugins: ${plugins}. See the \`aalis-plugin\` keyword on npm for the whole ecosystem.
`,
  },
};

export function renderPackageJson(
  projectName: string,
  enabled: Set<string>,
  versions: Map<string, string>,
  ui: UiLanguage,
): string {
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
      description: COPY[ui].description(projectName),
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

/** 入口：注释跟安装界面的语言，启动报错与仓库根的入口同一句英文 */
export function renderEntry(ui: UiLanguage): string {
  return `import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAalis } from '@aalis/runtime';

${COPY[ui].entry}
const here = dirname(fileURLToPath(import.meta.url));
startAalis({ appDir: here, defaultHome: join(here, 'home') }).catch(err => {
  console.error('Aalis failed to start:', err);
  process.exit(1);
});
`;
}

// 只有 owner 能进的平台（本地终端 / 单 token WebUI）的平台档开箱给全部工具分组，无条件写：平台没装时这一层不起作用，
// 之后从市场装上即生效。多人平台（OneBot 等）不代开：带分组的工具默认不暴露，public 工具在群里的可达性靠这道分组闸
// （docs/concepts/security-model.md），由 owner 在平台档里按需列组。平台档是会话设置的一层，写在配置文档的 sessionConfig 里、
// 按插件实例嵌套，由会话设置插件读。runtime 的 `--init`（home.ts 的 initHome）写同样的平台档，两边由用例核完全相等。
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

/**
 * 配置文档：插件段（pluginSettings 的结果），给了语言列表时另写 plugin-i18n 的 language（调用方只在这批插件里有它时给）；
 * 没有插件段时的注释跟安装界面的语言
 */
export function renderConfig(
  settings: Record<string, Record<string, string>>,
  ui: UiLanguage,
  languages?: readonly string[],
): string {
  const plugins: Record<string, Record<string, string | readonly string[]>> = languages
    ? { ...settings, [I18N]: { language: languages } }
    : settings;
  const lines = ['name: Aalis', 'logLevel: info'];
  const configured = Object.keys(plugins);
  if (configured.length > 0) {
    lines.push('plugins:');
    for (const name of configured) {
      lines.push(`  "${name}":`);
      // 值写成 JSON（字符串与字符串数组），同时也是合法的 YAML 双引号串与流式序列：引号、反斜杠、冒号与 # 原样读回
      for (const [key, value] of Object.entries(plugins[name])) lines.push(`    ${key}: ${JSON.stringify(value)}`);
    }
  } else {
    lines.push(COPY[ui].config, 'plugins: {}');
  }
  lines.push('sessionConfig:', '  platforms:');
  for (const platform of OWNER_PLATFORMS) {
    lines.push(`    ${platform}:`, '      "@aalis/plugin-tools":', '        enabledToolGroups: ["*"]');
  }
  lines.push('disabledPlugins: []');
  return `${lines.join('\n')}\n`;
}

function renderGitignore(): string {
  // 家目录 home/ 必须在列：配置、密钥与数据都在里面，入库即泄露。
  return `${['node_modules/', 'home/', '*.log', 'dist/'].join('\n')}\n`;
}

export function renderReadme(projectName: string, enabled: Set<string>, ui: UiLanguage): string {
  return COPY[ui].readme({ projectName, hasWebui: enabled.has(WEBUI), plugins: countPlugins(enabled) });
}

/** 结尾的「下一步」：进目录、Ollama 要拉的模型、启动，再点名还没填的密钥与去哪填 */
export function renderNextSteps(o: {
  dir: string;
  installed: boolean;
  enabled: Set<string>;
  keys: Keys;
  /** ollamaSteps 算出的命令 */
  ollama: TextRef[];
  tier: Tier;
}): TextRef {
  const hasWebui = o.enabled.has(WEBUI);
  const lines: Shown[] = [
    t('nextSteps'),
    `  cd ${o.dir}${o.installed ? '' : ' && npm install'}`,
    ...o.ollama.map(step => t('indented', { line: step })),
    '  npm start',
  ];
  const unfilled = [...o.enabled]
    .sort()
    .flatMap(name =>
      (KNOWN_CONFIG[name] ?? [])
        .filter(key => !o.keys[name]?.[key])
        .map(key => t('unfilledKey', { plugin: name, key })),
    );
  if (unfilled.length > 0) {
    lines.push('', t('unfilledKeys'), ...unfilled, t(hasWebui ? 'keyWhereWebui' : 'keyWhere'));
  }
  // full 档另装了不少要手配的插件（OneBot 的连接、MongoDB 的 uri 等），上面点名的不是全部
  if (o.tier === 'full') lines.push('', t('fullOthers'));
  lines.push('', t('firstRun', { url: FIRST_RUN_URL }));
  if (o.tier !== 'full') lines.push(t(hasWebui ? 'morePluginsWebui' : 'morePlugins'));
  return textLines([...lines, '']);
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
  explain(stderr: string, found: RegExpExecArray): TextRef[];
}> = [
  {
    kind: 'disk',
    match: /\bENOSPC\b/,
    explain: () => [t('diskReason'), t('diskFix')],
  },
  {
    kind: 'permission',
    match: /\bEACCES\b/,
    explain: () => [t('permissionReason'), t('permissionFix'), t('permissionExample')],
  },
  {
    kind: 'platform',
    match: /\bEBADPLATFORM\b/,
    explain: stderr => {
      const pkg = /Unsupported platform for (\S+?)@\d/.exec(stderr)?.[1];
      if (!pkg) return [t('platformReasonUnknown'), t('platformFixUnknown')];
      return [t('platformReason', { pkg }), t('platformFix', { pkg })];
    },
  },
  {
    kind: 'peer',
    match: /\bERESOLVE\b/,
    explain: () => [t('peerReason'), t('peerFix')],
  },
  {
    kind: 'browser',
    match: /Failed to set up (?:chrome|chrome-headless-shell|firefox)\b|node_modules[\\/]puppeteer\s*$/m,
    explain: () => [t('browserReason'), t('browserMirror'), t('browserSkip')],
  },
  {
    kind: 'native',
    match: /gyp ERR!|node-gyp|prebuild-install/,
    explain: stderr => {
      const pkg = /^npm (?:error|ERR!) path \S*node_modules[\\/]((?:@[^\\/\s]+[\\/])?[^\\/\s]+)\s*$/m.exec(stderr)?.[1];
      if (!pkg) return [t('nativeReasonUnknown'), t('nativeTools'), t('nativeReplaceUnknown')];
      return [t('nativeReason', { pkg }), t('nativeTools'), t('nativeReplace', { pkg })];
    },
  },
  {
    kind: 'missing',
    match: /\b(E404|ETARGET)\b/,
    explain: (_stderr, [, code]) => [t('missingReason', { code }), t('missingFix')],
  },
  {
    kind: 'network',
    match: /\b(ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/,
    explain: (_stderr, [, code]) => [t('networkReason', { code }), t('networkFix')],
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
export function describeInstallFailure(stderr: string, dir: string): TextRef {
  const known = recognize(stderr);
  const [reason, ...fixes] = known ? known.failure.explain(stderr, known.found) : [t('unknownReason')];
  const log = /A complete log of this run can be found in:\s*(\S+)/.exec(stderr)?.[1];
  return textLines([
    t('installFailed', { reason }),
    ...fixes,
    t('retry', { dir }),
    ...(log ? [t('npmLog', { log })] : []),
    t('troubleshooting', { url: TROUBLESHOOTING_URL }),
  ]);
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
const VALUE_FLAGS = new Set(['--tier', '--registry', '--lang']);

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
const NON_TTY_GUIDE = textLines(['', t('nonTty'), t('nonTtyYes'), t('nonTtyTier'), t('nonTtyKeys'), '']);

/** 选语言包时不装的那一项 */
const NO_PACK = '';

/** 提问得到的答案 */
export interface Answers {
  projectName: string;
  plan: Plan;
  /** 要装的插件：档与所选，加上一起装的语言包 */
  enabled: Set<string>;
  /** 当场粘贴的密钥（minimal 与 standard 档） */
  keys: Keys;
  /** Ollama 的探测结果：minimal 与 standard 档探过，其余档为 null */
  probe: OllamaProbe | null;
  /** 安装界面的语言：终端与生成的文件按它写 */
  ui: UiLanguage;
  /** 写进 plugin-i18n 配置的语言列表；这批插件里没有它时没有 */
  languages?: string[];
}

/**
 * 逐项定下装什么：安装界面的语言（没给 --lang 时第一问）、项目名、档与各档的所选；这批插件里有 plugin-i18n 时，没给 --lang 而
 * 系统语言没有插件提供的，交互模式去源上找语言包、非交互只提示，最后排语言列表（给了 --lang 时照它写）。没有终端提问时一律取默认
 */
export async function collect(
  prompter: Prompter | undefined,
  o: {
    name?: string;
    tier?: Tier;
    advanced: boolean;
    force: boolean;
    host?: string;
    lancedb: boolean;
    /** 识别到的系统语言（systemLanguage） */
    system: string;
    /** --lang 给的语言列表 */
    languages?: readonly string[];
    registry: string;
  },
): Promise<Answers> {
  let ui = uiLanguage(o.system, o.languages);
  const show = (text: Shown) => shown(text, ui);
  console.log(`\n${show(t('header'))}\n`);
  if (prompter && !o.languages) {
    const options = UI_LANGUAGES.map(tag => ({ name: tag, label: selfName(tag) }));
    ui = (await prompter.choose(t('uiLanguageTitle'), options, ui)).name;
    prompter.language = ui;
  }
  const projectName =
    o.name ?? (prompter ? await prompter.text(t('projectName'), 'my-aalis-bot', validateNpmName) : 'my-aalis-bot');
  const targetDir = resolve(cwd(), projectName);
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !o.force) {
    fail(show(t('dirNotEmpty', { dir: targetDir })));
  }
  const advanced = prompter !== undefined && o.advanced;
  if (prompter && !advanced) console.log(show(t('advancedHint')));
  const tier =
    o.tier ??
    (prompter && advanced ? (await prompter.choose(t('tierTitle'), TIER_OPTIONS, 'standard')).name : 'standard');

  let plan: Plan = { tier: 'bare' };
  let keys: Keys = {};
  let probe: OllamaProbe | null = null;
  if (tier === 'full') {
    // 插件目录：只有 full 档用它枚举全部官方插件，其余各档的插件是固定的
    const official = (await fetchCatalog(o.registry))?.filter(e => e.official).map(e => e.name);
    if (!official) console.warn(show(t('catalogOffline')));
    // 镜像源多不支持检索，却照样回 200 与空结果：不提示的话 full 档会悄悄少装
    else if (official.length === 0) console.warn(show(t('catalogEmpty', { registry: o.registry })));
    plan = { tier, catalog: official ?? null };
  } else if (tier !== 'bare') {
    probe = await probeOllama(o.host ?? OLLAMA_DEFAULT);
    if (probe) console.log(show(t(probe.chat ? 'ollamaFound' : 'ollamaFoundNoChat', { base: probe.base })));
    const ollama = probe !== null;
    const asked = prompter
      ? await askPicks(prompter, { tier, advanced, ollama, lancedb: o.lancedb })
      : { picks: defaultPicks(tier, ollama), keys: {} };
    plan = { tier, picks: asked.picks };
    keys = asked.keys;
  }
  const enabled = pluginSet(plan, o.lancedb);
  if (!enabled.has(I18N)) return { projectName, plan, enabled, keys, probe, ui };

  // 没给 --lang、系统语言又没有插件提供时：交互模式按关键词找语言包，问是否一起装；非交互不检索，只提示
  const provided = [...FIRST_PARTY_LANGUAGES];
  const language = { name: selfName(o.system), tag: o.system };
  if (!o.languages && matchLanguage([o.system], provided) === undefined) {
    if (prompter) {
      const found = await findLanguagePacks(o.registry, o.system);
      if (!found || found.names.length === 0) {
        console.warn(show(packSearchMiss(o.registry, !found, language)));
      } else {
        const options = [...found.names.map(name => ({ name, label: name })), { name: NO_PACK, label: t('packSkip') }];
        const pack = (await prompter.choose(t('packTitle', language), options, NO_PACK)).name;
        if (pack !== NO_PACK) {
          enabled.add(pack);
          provided.push(found.language);
        }
      }
    }
    if (matchLanguage([o.system], provided) === undefined) console.warn(show(t('languageUnprovided', language)));
  }
  // 默认的语言列表：系统语言有插件提供时排第一（写成提供它的那种，如 zh-TW 写 zh-CN），其后是安装界面的语言与其余
  const at = matchLanguage([o.system], provided);
  const defaults = [...new Set([...(at === undefined ? [] : [provided[at]]), ui, ...provided])];
  const languages = o.languages ? [...o.languages] : prompter ? await orderLanguages(prompter, defaults) : defaults;
  return { projectName, plan, enabled, keys, probe, ui, languages };
}

/** 排语言列表：列出各语言的自称，排好后显示整条链再确认，不确认就重排 */
async function orderLanguages(p: Prompter, defaults: readonly string[]): Promise<string[]> {
  const options = defaults.map(tag => ({ name: tag, label: selfName(tag) }));
  while (true) {
    const order = await p.order(t('languagesTitle'), options);
    if (await p.confirm(t('languageChain', { chain: order.map(tag => selfName(tag)).join(' → ') }), true)) return order;
  }
}

/**
 * 写出项目：package.json、入口、家目录（配置与空的密钥文件）、.gitignore 与 README。生成物的语言只取 answers.ui（第一问选的
 * 安装界面语言），不看识别到的系统语言
 */
export async function writeProject(
  answers: Answers,
  o: { dir: string; registry: string; host?: string },
): Promise<void> {
  const { projectName, enabled, keys, ui } = answers;
  mkdirSync(o.dir, { recursive: true });
  // 逐包解析当前最新版本（一律查注册表的 latest；失败回退 latest）
  const versions = await resolveDepRanges(o.registry, ['@aalis/core', '@aalis/runtime', ...enabled]);
  writeFileSync(resolve(o.dir, 'package.json'), renderPackageJson(projectName, enabled, versions, ui), 'utf-8');
  writeFileSync(resolve(o.dir, 'index.mjs'), renderEntry(ui), 'utf-8');
  // 家目录：配置文件存在即算初始化过（runtime 的判据），目录与两个文件都收紧权限
  const homeDir = resolve(o.dir, 'home');
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(homeDir, 'secrets.yaml'), '', { encoding: 'utf-8', mode: 0o600 });
  const config = renderConfig(pluginSettings(enabled, keys, o.host), ui, answers.languages);
  writeFileSync(resolve(homeDir, 'aalis.config.yaml'), config, { encoding: 'utf-8', mode: 0o600 });
  writeFileSync(resolve(o.dir, '.gitignore'), renderGitignore(), 'utf-8');
  writeFileSync(resolve(o.dir, 'README.md'), renderReadme(projectName, enabled, ui), 'utf-8');
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  // 建项目时识别一次系统语言：安装界面的语言、默认的语言列表与找语言包都按它
  const system = systemLanguage();
  const langFlag = argValue('--lang');
  const parsed = langFlag === undefined ? undefined : parseLanguages(langFlag);
  const languages = parsed?.ok ? parsed.languages : undefined;
  const ui = uiLanguage(system, languages);
  const show = (text: Shown) => shown(text, ui);

  const node = checkNodeVersion(version);
  if (!node.ok) fail(show(node.error));
  if (parsed && !parsed.ok) fail(show(parsed.error));
  const tierFlag = argValue('--tier');
  const interactive = !(args.includes('--yes') || args.includes('-y') || tierFlag !== undefined);
  const registry = argValue('--registry') ?? DEFAULT_REGISTRY;
  const name = positionalArgs(args)[0];
  if (interactive && !stdin.isTTY) fail(show(NON_TTY_GUIDE));
  if (name !== undefined) {
    const r = validateNpmName(name);
    if (!r.ok) fail(show(t('badProjectName', { name, error: r.error })));
  }
  const tier =
    tierFlag === undefined ? undefined : TIER_OPTIONS.find(option => option.name === tierFlag.toLowerCase())?.name;
  if (tierFlag !== undefined && tier === undefined) fail(show(t('unknownTier', { tier: tierFlag })));
  let host: string | undefined;
  try {
    host = ollamaHost(env.OLLAMA_HOST);
  } catch (err) {
    fail(show(textOf(err)));
  }
  const lancedb = lancedbSupported(platform, arch);

  // 问完就关掉终端提问：装依赖期间 Ctrl+C 要照常能中止 npm
  const prompter = interactive ? createPrompter(stdin, stdout, ui) : undefined;
  let answers: Answers;
  try {
    answers = await collect(prompter, {
      name,
      tier,
      advanced: args.includes('--advanced'),
      force: args.includes('--force'),
      host,
      lancedb,
      system,
      languages,
      registry,
    });
  } catch (err) {
    // 提问时按了 Ctrl+C：readline 随之关闭，没答完的那一问以 AbortError 结束。这时还没写任何文件
    if ((err as Error).name !== 'AbortError') throw err;
    console.error(`\n${shown(t('cancelled'), prompter?.language ?? ui)}`);
    exit(130);
  } finally {
    prompter?.close();
  }
  const { projectName, plan, enabled, keys } = answers;
  const say = (text: Shown) => shown(text, answers.ui);

  const targetDir = resolve(cwd(), projectName);
  await writeProject(answers, { dir: targetDir, registry, host });
  console.log(`\n${say(t('generated', { dir: targetDir, count: countPlugins(enabled) }))}`);

  const install = !args.includes('--no-install');
  if (install) {
    console.log(`\n${say(t('installing'))}\n`);
    const result = await npmInstall(targetDir);
    if (!result.ok) fail(`\n${say(describeInstallFailure(result.stderr, projectName))}`);
  }
  const ollama = plan.tier === 'minimal' || plan.tier === 'standard' ? ollamaSteps(plan.picks, answers.probe) : [];
  console.log(
    `\n${say(renderNextSteps({ dir: projectName, installed: install, enabled, keys, ollama, tier: plan.tier }))}`,
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

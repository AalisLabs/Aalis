#!/usr/bin/env node
// ============================================================
// create-aalis — 在新目录脚手架一个可运行的独立 Aalis 项目（纯 npm）
//
//   npm create aalis my-bot           → 交互：选模板档 + 同类适配器
//   npm create aalis my-bot -- --yes  → 非交互：standard 档 + 默认适配器
//   npm create aalis my-bot -- --tier minimal --no-install
//
// 产出一个独立项目目录：package.json（依赖 @aalis/core + @aalis/runtime + 所选插件）、
// index.mjs（一行 startAalis 启动）、aalis.config.yaml、README、.gitignore，
// 随后自动 npm install。启动：cd my-bot && npm start。
//
// 选插件心智：模板（bare/minimal/standard/full）+ 同类适配器组（LLM/平台/记忆/
// embedding/向量库）交互选用哪些，避免同类全塞冲突。所选插件即写入 dependencies，
// 由 @aalis/runtime 的 node_modules 加载器在启动时发现并加载。
// ============================================================

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, cwd, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

/** 模板档：每档是“基础启用集”，full 为全部目录、bare 为空。 */
type Tier = 'bare' | 'minimal' | 'standard' | 'full';

// 基础设施 + agent 套件：minimal 起步的自洽依赖闭包（网关路由 → 指令/agent →
// 会话 → 权限 → 跨会话历史）。同类适配器不在此列，由 GROUPS 交互选择补入。
const MINIMAL_BASE = [
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
  '@aalis/plugin-memory-history',
];

// standard 在 minimal 之上增加的常用能力（管理界面 / 人设 / 记忆增强 / 常用工具 /
// 调度套件 / 技能 / 归档 / 会话增强 / 诊断）。同类适配器仍由 GROUPS 选择。
const STANDARD_EXTRA = [
  '@aalis/plugin-webui-server',
  '@aalis/plugin-persona',
  '@aalis/plugin-memory-vector',
  '@aalis/plugin-memory-summary',
  '@aalis/plugin-user-profile',
  '@aalis/plugin-user-relation',
  '@aalis/plugin-file-reader',
  '@aalis/plugin-tool-system',
  '@aalis/plugin-tool-search',
  '@aalis/plugin-websearch-serper',
  '@aalis/plugin-media',
  '@aalis/plugin-scheduler',
  '@aalis/plugin-cron-engine',
  '@aalis/plugin-trigger-policy',
  '@aalis/plugin-todo-list',
  '@aalis/plugin-checkpoint',
  '@aalis/plugin-skills',
  '@aalis/plugin-message-archive',
  '@aalis/plugin-subtask',
  '@aalis/plugin-tool-session',
  '@aalis/plugin-doctor',
  '@aalis/plugin-mcp-client',
];

/** 同类适配器组：交互选用哪些（exclusive=单选，multi=可多选）。 */
interface AdapterGroup {
  key: string;
  label: string;
  mode: 'exclusive' | 'multi';
  members: Array<{ name: string; label: string; default?: boolean }>;
  tiers: Tier[];
}

const GROUPS: AdapterGroup[] = [
  {
    key: 'llm',
    label: 'LLM 提供者（对话模型，可多选）',
    mode: 'multi',
    tiers: ['minimal', 'standard'],
    members: [
      { name: '@aalis/plugin-llm-deepseek', label: 'DeepSeek', default: true },
      { name: '@aalis/plugin-llm-openai', label: 'OpenAI' },
      { name: '@aalis/plugin-llm-ollama', label: 'Ollama（本地）' },
    ],
  },
  {
    key: 'platform',
    label: '接入平台（消息入口，可多选）',
    mode: 'multi',
    tiers: ['minimal', 'standard'],
    members: [
      { name: '@aalis/plugin-cli', label: 'CLI 终端', default: true },
      { name: '@aalis/plugin-adapter-onebot', label: 'OneBot（QQ 等）' },
      { name: '@aalis/plugin-webui-server', label: 'WebUI 管理界面' },
    ],
  },
  {
    key: 'memory',
    label: '记忆后端（持久化，单选）',
    mode: 'exclusive',
    tiers: ['minimal', 'standard'],
    members: [
      { name: '@aalis/plugin-memory-sqlite', label: 'SQLite（本地文件，推荐）', default: true },
      { name: '@aalis/plugin-memory-inmemory', label: '内存（重启丢失）' },
      { name: '@aalis/plugin-memory-mongodb', label: 'MongoDB（需外部服务）' },
    ],
  },
  {
    key: 'embedding',
    label: 'Embedding 提供者（向量记忆所需，可多选）',
    mode: 'multi',
    tiers: ['standard'],
    members: [
      { name: '@aalis/plugin-embedding-openai', label: 'OpenAI Embedding', default: true },
      { name: '@aalis/plugin-embedding-ollama', label: 'Ollama Embedding（本地）' },
    ],
  },
  {
    key: 'vectorstore',
    label: '向量库（向量记忆所需，单选）',
    mode: 'exclusive',
    tiers: ['standard'],
    members: [
      { name: '@aalis/plugin-vectorstore-flat', label: 'Flat（内置，零依赖）', default: true },
      { name: '@aalis/plugin-vectorstore-lancedb', label: 'LanceDB（高性能）' },
    ],
  },
];

// 已知插件的配置桩。密钥留空由用户填 —— 直接写进 aalis.config.yaml，该文件不入库
// （见 renderGitignore）。曾经走 `.env` + `${VAR}` 插值，但它承载的东西与 config 完全重合，
// 唯一区别只是「哪个文件进 git」；把配置文件本身 ignore 掉之后那一层就纯属多余。
// 仅覆盖需密钥/地址的常见适配器；其余插件用默认配置启动。
const KNOWN_CONFIG: Record<string, { config: Record<string, string> }> = {
  '@aalis/plugin-llm-deepseek': { config: { apiKey: '' } },
  '@aalis/plugin-llm-openai': { config: { apiKey: '' } },
  '@aalis/plugin-embedding-openai': { config: { apiKey: '' } },
  '@aalis/plugin-websearch-serper': { config: { apiKey: '' } },
};

/** full 档 = 全目录（base ∪ extra ∪ 所有组成员）。 */
function fullCatalog(): string[] {
  const all = new Set<string>([...MINIMAL_BASE, ...STANDARD_EXTRA]);
  for (const g of GROUPS) for (const m of g.members) all.add(m.name);
  return [...all];
}

/** 计算启用集（不含交互组与 live "其他插件"；二者由 main 补入）。 */
function baseEnabled(tier: Tier): Set<string> {
  if (tier === 'full') return new Set(fullCatalog());
  if (tier === 'bare') return new Set();
  const set = new Set(MINIMAL_BASE);
  if (tier === 'standard') for (const n of STANDARD_EXTRA) set.add(n);
  return set;
}

// ── live 插件目录（init 时实时查 npm，列全生态供选） ────────────
//
// 搜索走官方源（keyword:aalis-plugin，同市场页约定）；npm 镜像（淘宝等）多不支持
// search API，故这里固定官方源、可 --registry 覆盖。生成项目的 npm install 仍用
// 用户自己的 npm 配置（与此解耦）。离线/失败回退到静态 STATIC_OTHERS。
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const AALIS_KEYWORD = 'aalis-plugin';

// 离线回退：仓库内已知、但不在 base/extra/groups 目录里的"其他"官方插件。
const STATIC_OTHERS = [
  'asr-openai',
  'asr-whisper-cpp',
  'image-sender',
  'maimai',
  'mcp-server',
  'office',
  'okx-trading',
  'tool-browser',
  'tool-code-runner',
  'tool-math',
  'tool-onebot',
  'workflow',
].map(s => `@aalis/plugin-${s}`);

interface CatalogEntry {
  name: string;
  description: string;
  official: boolean;
  /** npm search 返回的最新版本（用于脚手架逐包写 `^<最新>`，省一次单独查询） */
  version?: string;
}

/**
 * npm search 响应 → 插件目录条目。脚手架只列**可装功能插件**。
 *
 * 类型区分完全靠关键词，**不看包名**：检索用的是 `keywords:aalis-plugin`，而契约包带
 * `aalis-api`、前端带 `aalis-interface`、工具库带 `aalis-util`——它们根本不会出现在结果里。
 * 此处曾按包名剔除 `*-api` 与 `webui-client*`，那是关键词收敛（包按类型打词）之前的写法，
 * 收敛之后即成死代码，且按名判定会被改名打穿：`plugin-*-api` → `api-*` 之后 `/-api$/` 全部失配。
 *
 * 剩下的 `code-sandbox` 是**真功能插件**（带 aalis-plugin），排除理由与类型无关：它是被
 * code_runner 按需拉起的沙箱基建，不是用户「选功能」时该看到的条目。
 * 纯函数，便于单测。
 */
export function toPluginCatalog(data: {
  objects?: Array<{ package: { name: string; description?: string; version?: string } }>;
}): CatalogEntry[] {
  return (
    (data.objects ?? [])
      // 短名仍带 `plugin-` 前缀（如 plugin-code-sandbox-os），故用非锚定匹配，勿用 /^code-sandbox/。
      .filter(o => !/code-sandbox/.test(o.package.name.replace(/^@[^/]+\//, '')))
      .map(o => ({
        name: o.package.name,
        description: o.package.description ?? '',
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
 * 由调用方重问；不再像旧实现那样 parseInt 宽容 + filter 静默丢弃坏输入。
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

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * 校验是否为合法 npm 包名（生成项目/插件的 package.json `name`）。覆盖 npm 核心规则的常见子集：
 * 全小写、≤214 字符、无空格、不以 . 或 _ 开头、仅 url-safe 字符、可选 @scope/ 前缀。
 * 旧实现仅用宽松正则（放行 MyBot / 全点名等）或只查非空，会生成无法 install/publish 的名字。
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

function renderPackageJson(projectName: string, enabled: string[], versions: Map<string, string>): string {
  const range = (n: string): string => versions.get(n) ?? 'latest';
  const deps: Record<string, string> = {
    '@aalis/core': range('@aalis/core'),
    '@aalis/runtime': range('@aalis/runtime'),
  };
  for (const n of enabled.sort()) deps[n] = range(n);
  return `${JSON.stringify(
    {
      name: projectName,
      version: '0.1.0',
      private: true,
      type: 'module',
      description: `${projectName} —— 基于 Aalis 的 AI 助手`,
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
  return `import { startAalis } from '@aalis/runtime';

// 从 aalis.config.yaml 读配置、从 node_modules 加载已装的 @aalis 插件、启动。
// 默认开启控制台彩色日志 + data/latest.log 文件日志（无 TTY 时自动关闭染色）。
startAalis().catch(err => {
  console.error('Aalis 启动失败:', err);
  process.exit(1);
});
`;
}

function renderConfig(enabled: Set<string>): string {
  const lines = ['name: Aalis', 'logLevel: info'];
  const configured = [...enabled].filter(n => KNOWN_CONFIG[n]).sort();
  if (configured.length > 0) {
    lines.push('plugins:');
    for (const n of configured) {
      lines.push(`  "${n}":`);
      for (const [k, v] of Object.entries(KNOWN_CONFIG[n].config)) {
        lines.push(`    ${k}: "${v}"`);
      }
    }
  } else {
    lines.push('# 启用的插件用默认配置启动；需要密钥/地址的在下方 plugins 段填写或用 ${ENV} 引用环境变量。');
    lines.push('plugins: {}');
  }
  lines.push('disabledPlugins: []');
  return `${lines.join('\n')}\n`;
}

function renderGitignore(): string {
  // `aalis.config.yaml` 必须在列：密钥直接写在里面（不再有 `.env` 那一层），入库即泄露。
  return `${['node_modules/', 'data/', '*.log', 'aalis.config.yaml', 'dist/'].join('\n')}\n`;
}

function renderReadme(projectName: string, enabled: Set<string>): string {
  const hasWebui = enabled.has('@aalis/plugin-webui-server');
  return `# ${projectName}

基于 [Aalis](https://www.npmjs.com/package/@aalis/core) 脚手架生成的独立 AI 助手项目。

## 启动

\`\`\`bash
npm install        # 若 create 时跳过了安装
npm start
\`\`\`

## 配置

- 编辑 \`aalis.config.yaml\` 调整插件与参数。
- 密钥/令牌：直接填进 \`aalis.config.yaml\`（该文件已在 \`.gitignore\` 里，不会入库）${
    hasWebui ? '，或启动后在 WebUI 配置页填写。' : '。'
  }
${hasWebui ? '- WebUI 管理界面默认 http://127.0.0.1:8080 。\n' : ''}
## 装更多插件

\`\`\`bash
npm install @aalis/plugin-<name>   # 装上即被自动发现加载
\`\`\`
${hasWebui ? '或在 WebUI 的「插件市场」页搜索安装。\n' : ''}
> 启用集：${[...enabled].length} 个插件。完整生态见 npm 上的 \`aalis-plugin\` 关键词。
`;
}

// ── 主流程 ──────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const tierFlag = argValue('--tier') as Tier | undefined;
  const skip = argv.includes('--yes') || argv.includes('-y') || tierFlag !== undefined;
  const noInstall = argv.includes('--no-install');
  const force = argv.includes('--force');
  const registry = argValue('--registry') ?? DEFAULT_REGISTRY;
  const positional = argv.slice(2).filter(a => !a.startsWith('-'));
  const cliName = positional[0];

  // 非交互终端（管道 / 某些 IDE 终端 / CI）下进交互模式会在 readline 遇 EOF 时静默空退
  // （exit 0、无项目、无报错）。提前拦截并给可操作指引，避免「看着像用不了」。
  if (!skip && !stdin.isTTY) {
    console.error(
      '\n检测到非交互式环境（stdin 不是 TTY），无法进入选择界面。请改用非交互模式，例如：\n' +
        '  npm create aalis <名> -- --yes              # standard 档 + 默认适配器\n' +
        '  npm create aalis <名> -- --tier minimal     # 指定模板档 bare/minimal/standard/full\n',
    );
    exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  // 重问式提问：校验失败时打印错误并重问，不静默接受坏输入。
  const askValid = async (q: string, def: string, validate: (v: string) => ValidationResult): Promise<string> => {
    while (true) {
      const ans = (await rl.question(`${q} (${def}): `)).trim() || def;
      const r = validate(ans);
      if (r.ok) return ans;
      console.log(`  ⚠ ${r.error}`);
    }
  };
  // 序号选择：兼容逗号或空格分隔，坏输入重问；空串=用默认集。
  const askIndices = async (
    q: string,
    count: number,
    mode: 'multi' | 'exclusive',
    defaults: number[],
  ): Promise<number[]> => {
    while (true) {
      const raw = (await rl.question(`${q}: `)).trim();
      if (raw === '') return defaults;
      const r = parseIndexSelection(raw, count, mode);
      if (r.ok) return r.indices;
      console.log(`  ⚠ ${r.error}`);
    }
  };

  try {
    console.log('\n=== 创建 Aalis 项目 ===\n');

    // 项目名 → 生成 package.json 的 name，须为合法 npm 包名（交互时重问，flag/arg 给错则退出）。
    let projectName: string;
    if (cliName !== undefined) {
      const r = validateNpmName(cliName);
      if (!r.ok) {
        console.error(`非法项目名「${cliName}」：${r.error}`);
        exit(1);
      }
      projectName = cliName;
    } else if (skip) {
      projectName = 'my-aalis-bot';
    } else {
      projectName = await askValid('项目目录名', 'my-aalis-bot', validateNpmName);
    }

    const targetDir = resolve(cwd(), projectName);
    if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !force) {
      console.error(`目录已存在且非空: ${targetDir}（加 --force 覆盖写入）`);
      exit(1);
    }

    console.log('\n模板档：');
    console.log('  bare      只装 Aalis Core + runtime（完全自定义起点）');
    console.log('  minimal   最简对话实例（网关+Agent+权限+会话+1 LLM+1 平台+记忆）');
    console.log('  standard  常用全家桶（minimal + WebUI/人设/向量记忆/工具/调度/技能…）');
    console.log('  full      全部官方插件（实时查 npm 全装，可能需手动取舍）\n');
    console.log('（更多插件不在终端铺列——建好后在 WebUI 插件市场搜索安装，对齐 Koishi 做法）\n');

    const validTier = (v: string): ValidationResult =>
      ['bare', 'minimal', 'standard', 'full'].includes(v.toLowerCase())
        ? { ok: true }
        : { ok: false, error: `未知模板档「${v}」，请输入 bare / minimal / standard / full。` };
    let tier: Tier;
    if (tierFlag !== undefined) {
      const r = validTier(tierFlag);
      if (!r.ok) {
        console.error(r.error);
        exit(1);
      }
      tier = tierFlag.toLowerCase() as Tier;
    } else if (skip) {
      tier = 'standard';
    } else {
      tier = (await askValid('模板档 [bare/minimal/standard/full]', 'standard', validTier)).toLowerCase() as Tier;
    }

    const enabled = baseEnabled(tier);

    // 同类适配器交互选择（仅 minimal/standard，且仅该档出现的组）；坏输入重问。
    if (tier === 'minimal' || tier === 'standard') {
      for (const group of GROUPS) {
        if (!group.tiers.includes(tier)) continue;
        console.log(`\n${group.label}:`);
        for (const [i, m] of group.members.entries()) console.log(`  ${i + 1}. ${m.label}`);
        const defaults = group.members.filter(m => m.default).map(m => group.members.indexOf(m) + 1);
        const defStr = group.mode === 'exclusive' ? String(defaults[0] ?? 1) : defaults.join(',') || '无';
        const q =
          group.mode === 'exclusive'
            ? `选一个（序号，回车=默认 ${defStr}）`
            : `选若干（逗号或空格分隔序号，回车=默认 ${defStr}）`;
        const picks = skip ? defaults : await askIndices(q, group.members.length, group.mode, defaults);
        for (const idx of picks) enabled.add(group.members[idx - 1].name);
      }
    }

    // 插件目录：full 档用它枚举全部官方插件；非 bare 档也复用其版本号，省去逐包查询。
    // 注意：旧版「其他插件」live 全列表多选已撤——长尾插件发现交给 WebUI 市场（见上提示）。
    let catalog: CatalogEntry[] | null = null;
    if (tier !== 'bare') {
      catalog = await fetchCatalog(registry);
      if (!catalog && tier === 'full') console.warn('（无法连接 npm，full 档回退离线静态表）');
    }
    if (tier === 'full') {
      // full = 全部官方插件：live 优先，失败回退静态（baseEnabled(full) 已含 base∪extra∪groups）
      if (catalog) {
        for (const e of catalog) if (e.official) enabled.add(e.name);
      } else {
        for (const n of STATIC_OTHERS) enabled.add(n);
      }
    }

    // 选了 WebUI 后端就自动带上前端 + 安装引擎：
    // - webui-client：webui-server 仅托管前端静态资源，自身不含；缺它会 404
    //   「请安装 webui-client 插件」。它非运行时插件（无 apply），装上即被自动发现挂载。
    // - package-manager：否则市场页"安装"会报 503（webui-server 仅把它列为 dev 依赖）。
    if (enabled.has('@aalis/plugin-webui-server')) {
      enabled.add('@aalis/plugin-webui-client');
      enabled.add('@aalis/plugin-package-manager');
    }

    // 选了 code_runner 就自动带上 OS 沙箱实现：默认 sandbox.mode=auto，缺沙箱后端会 fail-closed
    // 拒绝执行代码，故把隔离实现一并装上（macOS sandbox-exec 自带；Linux 还需系统装 bubblewrap）。
    if (enabled.has('@aalis/plugin-tool-code-runner')) {
      enabled.add('@aalis/plugin-code-sandbox-os');
    }

    // 写文件
    mkdirSync(targetDir, { recursive: true });
    const enabledList = [...enabled];
    // 逐包解析当前最新版本（复用 catalog；core/runtime 实时查；失败回退 latest）
    const versions = await resolveDepRanges(registry, ['@aalis/core', '@aalis/runtime', ...enabledList], catalog);
    writeFileSync(resolve(targetDir, 'package.json'), renderPackageJson(projectName, enabledList, versions), 'utf-8');
    writeFileSync(resolve(targetDir, 'index.mjs'), renderEntry(), 'utf-8');
    writeFileSync(resolve(targetDir, 'aalis.config.yaml'), renderConfig(enabled), 'utf-8');
    writeFileSync(resolve(targetDir, '.gitignore'), renderGitignore(), 'utf-8');
    writeFileSync(resolve(targetDir, 'README.md'), renderReadme(projectName, enabled), 'utf-8');

    console.log(`\n✓ 已生成项目: ${targetDir}（启用 ${enabledList.length} 个插件）`);

    // 安装依赖
    if (!noInstall) {
      console.log('\n正在 npm install（可能需要几分钟）…\n');
      const r = spawnSync('npm', ['install'], {
        cwd: targetDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      if (r.status !== 0) {
        console.error('\nnpm install 失败。可手动进入目录重试：');
        console.error(`  cd ${projectName} && npm install`);
        exit(1);
      }
    }

    console.log('\n下一步：');
    if (noInstall) console.log(`  cd ${projectName} && npm install`);
    else console.log(`  cd ${projectName}`);
    const needsKey = enabledList.some(n => KNOWN_CONFIG[n]);
    if (needsKey) console.log('  # 在 aalis.config.yaml 里填入 API key（该文件不入库）');
    console.log('  npm start');
    if (tier !== 'full') {
      const hasWebui = enabled.has('@aalis/plugin-webui-server');
      console.log(
        hasWebui
          ? '\n更多插件：启动后在 WebUI 的「插件市场」页搜索安装（或 npm install @aalis/plugin-<name>）。'
          : '\n更多插件：npm install @aalis/plugin-<name> 即可（装上自动发现加载）；装 webui-server 后还可用图形化插件市场。',
      );
    }
    console.log('');
  } finally {
    rl.close();
  }
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

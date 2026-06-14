#!/usr/bin/env node
// ============================================================
// create-aalis — 在新目录脚手架一个可运行的独立 Aalis 项目（纯 npm）
//
//   npm create aalis my-bot           → 交互：选模板档 + 同类适配器
//   npm create aalis my-bot -- --yes  → 非交互：standard 档 + 默认适配器
//   npm create aalis my-bot -- --tier minimal --no-install
//
// 产出一个独立项目目录：package.json（依赖 @aalis/core + @aalis/runtime + 所选插件）、
// index.mjs（一行 startAalis 启动）、aalis.config.yaml、README、.gitignore、.env.example，
// 随后自动 npm install。启动：cd my-bot && npm start。
//
// 选插件心智：模板（bare/minimal/standard/full）+ 同类适配器组（LLM/平台/记忆/
// embedding/向量库）交互选用哪些，避免同类全塞冲突。所选插件即写入 dependencies，
// 由 @aalis/runtime 的 node_modules 加载器在启动时发现并加载。
// ============================================================

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, cwd, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

/** scaffold 写入 dependencies 的版本范围。发布新主版本时同步更新。 */
const AALIS_RANGE = '^0.1.0';

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
  '@aalis/plugin-session-channel',
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
      { name: '@aalis/plugin-deepseek', label: 'DeepSeek', default: true },
      { name: '@aalis/plugin-openai', label: 'OpenAI' },
      { name: '@aalis/plugin-ollama', label: 'Ollama（本地）' },
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

// 已知插件的配置桩 + 引用的环境变量（写进 aalis.config.yaml 与 .env.example）。
// 仅覆盖需密钥/地址的常见适配器；其余插件用默认配置启动。
const KNOWN_CONFIG: Record<string, { config: Record<string, string>; env?: string[] }> = {
  '@aalis/plugin-deepseek': { config: { apiKey: '${DEEPSEEK_API_KEY}' }, env: ['DEEPSEEK_API_KEY'] },
  '@aalis/plugin-openai': { config: { apiKey: '${OPENAI_API_KEY}' }, env: ['OPENAI_API_KEY'] },
  '@aalis/plugin-embedding-openai': { config: { apiKey: '${OPENAI_API_KEY}' }, env: ['OPENAI_API_KEY'] },
  '@aalis/plugin-websearch-serper': { config: { apiKey: '${SERPER_API_KEY}' }, env: ['SERPER_API_KEY'] },
};

/** full 档 = 全目录（base ∪ extra ∪ 所有组成员）。 */
function fullCatalog(): string[] {
  const all = new Set<string>([...MINIMAL_BASE, ...STANDARD_EXTRA]);
  for (const g of GROUPS) for (const m of g.members) all.add(m.name);
  return [...all];
}

/** 计算启用集（不含交互组；交互组由 main 补入）。 */
function baseEnabled(tier: Tier): Set<string> {
  if (tier === 'full') return new Set(fullCatalog());
  if (tier === 'bare') return new Set();
  const set = new Set(MINIMAL_BASE);
  if (tier === 'standard') for (const n of STANDARD_EXTRA) set.add(n);
  return set;
}

// ── 生成的文件 ──────────────────────────────────────────────

function renderPackageJson(projectName: string, enabled: string[]): string {
  const deps: Record<string, string> = {
    '@aalis/core': AALIS_RANGE,
    '@aalis/runtime': AALIS_RANGE,
  };
  for (const n of enabled.sort()) deps[n] = AALIS_RANGE;
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

function renderEnvExample(enabled: Set<string>): string {
  const vars = new Set<string>();
  for (const n of enabled) for (const e of KNOWN_CONFIG[n]?.env ?? []) vars.add(e);
  if (vars.size === 0)
    return '# 本项目所选插件未引用环境变量。需要时在此添加，并在 aalis.config.yaml 用 ${VAR} 引用。\n';
  return `# 复制为 .env 并填值（或直接在 aalis.config.yaml 写死）。aalis.config.yaml 用 \${VAR} 引用。\n${[...vars]
    .sort()
    .map(v => `${v}=`)
    .join('\n')}\n`;
}

function renderGitignore(): string {
  return `${['node_modules/', 'data/', '*.log', '.env', 'dist/'].join('\n')}\n`;
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
- 密钥/令牌：填入 \`.env\`（参考 \`.env.example\`），在 \`aalis.config.yaml\` 用 \`\${VAR}\` 引用；${
    hasWebui ? '或启动后在 WebUI 配置页填写。' : '或直接写入 aalis.config.yaml。'
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
  const positional = argv.slice(2).filter(a => !a.startsWith('-'));
  const cliName = positional[0];

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def: string): Promise<string> => {
    if (skip) return def;
    const ans = (await rl.question(`${q} (${def}): `)).trim();
    return ans || def;
  };

  try {
    console.log('\n=== 创建 Aalis 项目 ===\n');
    const projectName = cliName ?? (await ask('项目目录名', 'my-aalis-bot'));
    if (!/^[a-zA-Z0-9._@/-]+$/.test(projectName)) {
      console.error(`非法项目名: ${projectName}`);
      exit(1);
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
    console.log('  full      目录内全部插件（同类适配器一并全装，可能需手动取舍）\n');
    const tier = (tierFlag ?? (await ask('模板档 [bare/minimal/standard/full]', 'standard'))).toLowerCase() as Tier;
    if (!['bare', 'minimal', 'standard', 'full'].includes(tier)) {
      console.error(`未知模板档: ${tier}`);
      exit(1);
    }

    const enabled = baseEnabled(tier);

    // 同类适配器交互选择（仅 minimal/standard，且仅该档出现的组）
    if (tier === 'minimal' || tier === 'standard') {
      for (const group of GROUPS) {
        if (!group.tiers.includes(tier)) continue;
        console.log(`\n${group.label}:`);
        for (const [i, m] of group.members.entries()) console.log(`  ${i + 1}. ${m.label}`);
        const defaults = group.members.filter(m => m.default).map(m => group.members.indexOf(m) + 1);
        const defStr = group.mode === 'exclusive' ? String(defaults[0] ?? 1) : defaults.join(',');
        const raw = await ask(
          group.mode === 'exclusive' ? '选一个（序号）' : '选若干（逗号分隔序号，留空=默认）',
          defStr,
        );
        const picks = raw
          .split(',')
          .map(s => Number.parseInt(s.trim(), 10))
          .filter(n => n >= 1 && n <= group.members.length);
        const chosen = group.mode === 'exclusive' ? picks.slice(0, 1) : picks;
        for (const idx of chosen.length > 0 ? chosen : defaults) enabled.add(group.members[idx - 1].name);
      }
    }

    // 写文件
    mkdirSync(targetDir, { recursive: true });
    const enabledList = [...enabled];
    writeFileSync(resolve(targetDir, 'package.json'), renderPackageJson(projectName, enabledList), 'utf-8');
    writeFileSync(resolve(targetDir, 'index.mjs'), renderEntry(), 'utf-8');
    writeFileSync(resolve(targetDir, 'aalis.config.yaml'), renderConfig(enabled), 'utf-8');
    writeFileSync(resolve(targetDir, '.env.example'), renderEnvExample(enabled), 'utf-8');
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
    const needsEnv = enabledList.some(n => KNOWN_CONFIG[n]?.env?.length);
    if (needsEnv) console.log('  cp .env.example .env   # 填入 API key');
    console.log('  npm start');
    console.log('');
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(err);
  exit(1);
});

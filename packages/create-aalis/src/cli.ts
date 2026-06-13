#!/usr/bin/env node
// ============================================================
// create-aalis — Aalis 快速初始化脚手架
//
//   create-aalis              → 交互式：选模板档 + 同类适配器 → 写 aalis.config.yaml
//   create-aalis --yes        → 非交互：用 standard 档 + 默认适配器
//
// 现状（Aalis 暂未发 npm）：脚手架在 monorepo 根运行，扫描本地 packages/ 的
// 真实插件，按"模板档 + 同类组选择 + 微调"生成 aalis.config.yaml（启用集 =
// 全部插件 − disabledPlugins）。敏感配置（API key / 平台 token）留 WebUI 配置页填。
//
// 设计：选插件心智 = 模板（bare/minimal/standard/full）+ 微调；同类适配器
// （LLM / 平台 / 记忆后端 / 向量库 / embedding / ASR）交互选用哪些，避免全塞冲突。
// ============================================================

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, cwd, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

interface PluginMeta {
  name: string;
  displayName: string;
  subsystem: string;
}

/** 模板档：每档是"基础启用集"，full 为全部、bare 为空。 */
type Tier = 'bare' | 'minimal' | 'standard' | 'full';

// ── curated 归类（随仓库插件增减维护） ──────────────────────
//
// 基础设施 + agent 套件：minimal 起步的自洽依赖闭包（让 Aalis 能跑起一个最简
// 对话实例：网关路由 → 指令/agent → 会话 → 权限）。同类适配器不在此列，由
// GROUPS 交互选择补入。
const MINIMAL_BASE = [
  '@aalis/plugin-storage-local', // storage 网关实现（众多插件依赖）
  '@aalis/plugin-process-local', // process 网关实现
  '@aalis/plugin-gateway', // 入站消息路由
  '@aalis/plugin-commands', // 内置指令
  '@aalis/plugin-flow-control', // 消息流控
  '@aalis/plugin-agent', // Agent 核心
  '@aalis/plugin-tools', // 工具注册表
  '@aalis/plugin-prompt-budget', // Agent 套件：预算自检
  '@aalis/plugin-authority', // 权限（商业级默认带）
  '@aalis/plugin-session-manager', // 会话管理
  '@aalis/plugin-memory-history', // 跨会话历史上下文
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
  /** 该组在哪些档出现（bare 永不问） */
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

const CONFIG_FILE = 'aalis.config.yaml';

/** 扫描 monorepo packages/ 下的真实插件（导出 apply、非 -api 包）。 */
function scanPlugins(packagesDir: string): PluginMeta[] {
  const out: PluginMeta[] = [];
  for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const idx = resolve(packagesDir, dirent.name, 'src/index.ts');
    const pkg = resolve(packagesDir, dirent.name, 'package.json');
    if (!existsSync(idx) || !existsSync(pkg)) continue;
    const src = readFileSync(idx, 'utf-8');
    if (!/export\s+(?:async\s+function\s+apply|function\s+apply|const\s+apply)/.test(src)) continue;
    const name = (JSON.parse(readFileSync(pkg, 'utf-8')) as { name?: string }).name ?? '';
    if (!name || name.endsWith('-api')) continue;
    const displayName = src.match(/export\s+const\s+displayName\s*=\s*'([^']+)'/)?.[1] ?? name;
    const subsystem = src.match(/export\s+const\s+subsystem\s*=\s*'([^']+)'/)?.[1] ?? 'other';
    out.push({ name, displayName, subsystem });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 生成 aalis.config.yaml 文本（启用集 enabled，其余进 disabledPlugins）。 */
function renderConfig(all: PluginMeta[], enabled: Set<string>): string {
  const disabled = all.map(p => p.name).filter(n => !enabled.has(n));
  const lines = [
    'name: Aalis',
    'logLevel: info',
    '# 启用的插件用默认配置启动；敏感配置（API key/token）请在 WebUI 配置页填写。',
    'plugins: {}',
  ];
  if (disabled.length > 0) {
    lines.push('disabledPlugins:');
    for (const n of disabled) lines.push(`  - "${n}"`);
  } else {
    lines.push('disabledPlugins: []');
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  // --tier <bare|minimal|standard|full>：非交互指定档位（同类适配器取默认），
  // 利于 CI/脚本化初始化。--yes 等价于 --tier standard。
  const tierIdx = argv.indexOf('--tier');
  const tierFlag = tierIdx >= 0 ? argv[tierIdx + 1] : undefined;
  const skip = argv.includes('--yes') || argv.includes('-y') || tierFlag !== undefined;
  const packagesDir = resolve(cwd(), 'packages');
  if (!existsSync(packagesDir)) {
    console.error(`未找到 packages/ 目录（当前: ${cwd()}）。请在 Aalis 仓库根目录运行 create-aalis。`);
    exit(1);
  }
  const all = scanPlugins(packagesDir);
  if (all.length === 0) {
    console.error('packages/ 下未扫描到任何插件。');
    exit(1);
  }
  const known = new Set(all.map(p => p.name));

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def: string): Promise<string> => {
    if (skip) return def;
    const ans = (await rl.question(`${q} (${def}): `)).trim();
    return ans || def;
  };

  try {
    console.log('\n=== Aalis 快速初始化 ===\n');
    console.log(`扫描到 ${all.length} 个本地插件。选择一个模板档，随后微调同类适配器。\n`);
    console.log('  bare      只启用 Aalis Core（不启用任何官方插件，完全自定义起点）');
    console.log('  minimal   最简对话实例（网关+Agent+权限+会话+1 个 LLM+1 个平台+记忆）');
    console.log('  standard  常用全家桶（minimal + WebUI/人设/向量记忆/工具/调度/技能…）');
    console.log('  full      启用全部本地插件（同类适配器一并全装，可能需手动取舍）\n');
    const tier = (tierFlag ?? (await ask('模板档 [bare/minimal/standard/full]', 'standard'))).toLowerCase() as Tier;
    if (!['bare', 'minimal', 'standard', 'full'].includes(tier)) {
      console.error(`未知模板档: ${tier}`);
      exit(1);
    }

    const enabled = new Set<string>();
    if (tier === 'full') {
      for (const p of all) enabled.add(p.name);
    } else if (tier !== 'bare') {
      for (const n of MINIMAL_BASE) if (known.has(n)) enabled.add(n);
      if (tier === 'standard') for (const n of STANDARD_EXTRA) if (known.has(n)) enabled.add(n);

      // 同类适配器交互选择（仅问该档出现的组）
      for (const group of GROUPS) {
        if (!group.tiers.includes(tier)) continue;
        const members = group.members.filter(m => known.has(m.name));
        if (members.length === 0) continue;
        console.log(`\n${group.label}:`);
        for (const [i, m] of members.entries()) console.log(`  ${i + 1}. ${m.label}`);
        const defaults = members.filter(m => m.default).map(m => members.indexOf(m) + 1);
        const defStr = group.mode === 'exclusive' ? String(defaults[0] ?? 1) : defaults.join(',');
        const raw = await ask(
          group.mode === 'exclusive' ? '选一个（序号）' : '选若干（逗号分隔序号，留空=默认）',
          defStr,
        );
        const picks = raw
          .split(',')
          .map(s => Number.parseInt(s.trim(), 10))
          .filter(n => n >= 1 && n <= members.length);
        const chosen = group.mode === 'exclusive' ? picks.slice(0, 1) : picks;
        for (const idx of chosen.length > 0 ? chosen : defaults) enabled.add(members[idx - 1].name);
      }
    }

    // 微调：额外启用/禁用（可跳过）
    if (!skip && tier !== 'bare') {
      const extra = (await ask('\n额外启用的插件名（逗号分隔，留空跳过）', '')).trim();
      for (const n of extra
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)) {
        if (known.has(n)) enabled.add(n);
        else console.warn(`  忽略未知插件: ${n}`);
      }
      const off = (await ask('额外禁用的插件名（逗号分隔，留空跳过）', '')).trim();
      for (const n of off
        .split(',')
        .map(s => s.trim())
        .filter(Boolean))
        enabled.delete(n);
    }

    const target = resolve(cwd(), CONFIG_FILE);
    if (existsSync(target)) {
      if (skip) {
        // 非交互模式遇已存在文件：必须 --force 才覆盖，否则明确报错（不静默跳过）
        if (!argv.includes('--force')) {
          console.error(`${CONFIG_FILE} 已存在。非交互模式（--tier/--yes）请加 --force 覆盖。`);
          exit(1);
        }
      } else {
        const ow = await ask(`\n${CONFIG_FILE} 已存在，覆盖？[y/N]`, 'N');
        if (ow.toLowerCase() !== 'y') {
          console.log('已取消，未写入。');
          exit(0);
        }
      }
    }
    writeFileSync(target, renderConfig(all, enabled), 'utf-8');
    console.log(`\n✓ 已写入 ${CONFIG_FILE}：启用 ${enabled.size} / ${all.length} 个插件。`);
    console.log('  启动：pnpm dev    然后在 WebUI 配置页填写 API key / 平台 token。\n');
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(err);
  exit(1);
});

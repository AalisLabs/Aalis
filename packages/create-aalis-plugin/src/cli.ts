#!/usr/bin/env node
/**
 * Aalis 插件交互式脚手架。
 *
 * 用法：
 *   create-aalis-plugin                 → 交互式 prompts
 *   create-aalis-plugin <name>          → 仅指定名称，其余 prompts
 *   create-aalis-plugin <name> --yes    → 全默认值（tool 模板，无 webui）
 *
 * 输出：在 cwd 下创建 `<name>/` 目录，含完整 package.json / tsconfig.json /
 * src/index.ts。生成完毕后打印下一步命令。
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

interface Answers {
  /** 包名，如 my-plugin 或 @scope/my-plugin */
  packageName: string;
  /** 显示名 */
  displayName: string;
  /** 包含哪些扩展点 */
  features: {
    tool: boolean;
    command: boolean;
    webui: boolean;
  };
}

// ── 输入校验（纯函数，便于单测）─────────────────────────────────
// 注：validateNpmName 与 create-aalis 中实现刻意一致——两者都是零运行时依赖的独立脚手架，
// 为不引入共享依赖而各留一份；改规则时需同步。

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** 校验合法 npm 包名（生成插件 package.json 的 name；旧实现只查非空，会生成无法发布的名字）。 */
export function validateNpmName(name: string): ValidationResult {
  if (!name) return { ok: false, error: '名称不能为空。' };
  if (name.length > 214) return { ok: false, error: '名称过长（>214 字符）。' };
  if (/\s/.test(name)) return { ok: false, error: '名称不能含空格。' };
  if (name !== name.toLowerCase()) return { ok: false, error: '名称必须全小写（npm 包名规则，如 my-plugin）。' };
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
    return { ok: false, error: '名称只能含小写字母、数字、- . _，且以字母或数字开头（如 my-plugin）。' };
  }
  return { ok: true };
}

/** 解析 yes/no 输入：空=默认；y/yes/true/1=真；n/no/false/0=假；其余=null（调用方重问）。 */
export function parseYesNo(ans: string, def: boolean): boolean | null {
  const a = ans.trim().toLowerCase();
  if (a === '') return def;
  if (['y', 'yes', 'true', '1'].includes(a)) return true;
  if (['n', 'no', 'false', '0'].includes(a)) return false;
  return null;
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  const skipPrompts = args.includes('--yes') || args.includes('-y');
  const positional = args.filter(a => !a.startsWith('-'));
  const cliName = positional[0];

  // 非交互终端下进交互会在 readline 遇 EOF 时静默空退；提前拦截并给指引（与 create-aalis 一致）。
  if (!skipPrompts && !stdin.isTTY) {
    console.error(
      '\n检测到非交互式环境（stdin 不是 TTY），无法进入交互。请改用：\n' +
        '  create-aalis-plugin <包名> --yes    # 全默认（tool 模板）\n',
    );
    exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def?: string): Promise<string> => {
    if (skipPrompts && def !== undefined) return def;
    const suffix = def !== undefined ? ` (${def})` : '';
    const ans = (await rl.question(`${q}${suffix}: `)).trim();
    return ans || def || '';
  };
  // 校验式提问：坏输入打印错误并重问（仅交互模式）。
  const askValid = async (q: string, def: string, validate: (v: string) => ValidationResult): Promise<string> => {
    if (skipPrompts) return def;
    while (true) {
      const ans = (await rl.question(`${q} (${def}): `)).trim() || def;
      const r = validate(ans);
      if (r.ok) return ans;
      console.log(`  ⚠ ${r.error}`);
    }
  };
  const askYesNo = async (q: string, def = true): Promise<boolean> => {
    if (skipPrompts) return def;
    while (true) {
      const ans = await rl.question(`${q} (${def ? 'Y/n' : 'y/N'}): `);
      const r = parseYesNo(ans, def);
      if (r !== null) return r;
      console.log('  ⚠ 请输入 y 或 n。');
    }
  };

  try {
    let packageName: string;
    if (cliName !== undefined) {
      const r = validateNpmName(cliName);
      if (!r.ok) {
        console.error(`非法包名「${cliName}」：${r.error}`);
        exit(1);
      }
      packageName = cliName;
    } else {
      packageName = await askValid('包名（如 my-plugin 或 @scope/my-plugin）', 'aalis-plugin-sample', validateNpmName);
    }
    const displayName = await ask('显示名（中文标签）', defaultDisplayName(packageName));
    const features: Answers['features'] = {
      tool: await askYesNo('注册 AI 工具？', true),
      command: await askYesNo('注册斜杠命令？', false),
      webui: await askYesNo('提供 WebUI 页面？', false),
    };

    const answers: Answers = { packageName, displayName, features };
    const targetDir = resolve(process.cwd(), shortName(packageName));

    if (existsSync(targetDir)) {
      console.error(`目录已存在: ${targetDir}`);
      exit(1);
    }

    await generate(targetDir, answers);

    console.log(`\n✓ 已生成插件骨架: ${targetDir}\n`);
    console.log('下一步：');
    console.log(`  cd ${shortName(packageName)}`);
    console.log('  pnpm install');
    console.log('  pnpm build');
    console.log('\n要让 Aalis 加载它，把目录放进你的 Aalis 仓库的 packages/ 下，');
    console.log('然后在 aalis.config.yaml 的 plugins 段加上对应配置项即可。');
  } finally {
    rl.close();
  }
}

function defaultDisplayName(pkg: string): string {
  return shortName(pkg)
    .replace(/^plugin-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function shortName(pkg: string): string {
  const slash = pkg.lastIndexOf('/');
  return slash >= 0 ? pkg.slice(slash + 1) : pkg;
}

async function generate(dir: string, a: Answers): Promise<void> {
  await mkdir(resolve(dir, 'src'), { recursive: true });

  await writeFile(resolve(dir, 'package.json'), renderPackageJson(a));
  await writeFile(resolve(dir, 'tsconfig.json'), renderTsconfig());
  await writeFile(resolve(dir, 'src/index.ts'), renderIndexTs(a));
  await writeFile(resolve(dir, 'README.md'), renderReadme(a));
}

function renderPackageJson(a: Answers): string {
  // 运行时依赖：用了 useXxxService（运行时 helper）的 api 包进 dependencies；@aalis/core
  // 是宿主必有的核心，走 peerDependencies + devDep。
  // 注意：这里写进的是【生成给外部作者项目】的字面版本，不能用 workspace:（脚手架产物不在
  // 本 monorepo，workspace: 协议在外部装不上）——统一用 'latest'：npm install 时取最新、自我
  // 修正，不硬编码会过时的版本（与 create-aalis 同策略）。
  // core peerDep 用宽松区间 `>=0.2.0 <1.0.0`：兼容任何 0.x 宿主 core（core 承诺 0.x 内
  // 向后兼容、破坏性变更才升 1.0.0），插件不必随 core 次版本升级而重发——慢更新插件也跟得上。
  const deps: Record<string, string> = {};
  if (a.features.tool) deps['@aalis/plugin-tools-api'] = 'latest';
  if (a.features.command) deps['@aalis/plugin-commands-api'] = 'latest';
  if (a.features.webui) deps['@aalis/plugin-webui-api'] = 'latest';

  // aalis.service：声明运行时服务依赖/提供，供市场装前披露。示例插件无服务依赖，
  // 留空提示作者按需填（用了 ctx.inject.required / provides 时同步到这里）。
  const json: Record<string, unknown> = {
    name: a.packageName,
    version: '0.1.0',
    type: 'module',
    // description / author 供插件市场展示（市场直接读 package.json，不入 PluginModule）
    description: `${a.displayName} —— Aalis 插件`,
    // keyword 'aalis-plugin' 是市场发现约定：npm registry 按此 keyword 检索可装插件
    keywords: ['aalis-plugin'],
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    files: ['dist'], // 发布包只含编译产物
    scripts: {
      build: 'tsc',
      dev: 'tsc --watch',
    },
    ...(Object.keys(deps).length ? { dependencies: deps } : {}),
    peerDependencies: {
      '@aalis/core': '>=0.2.0 <1.0.0',
    },
    devDependencies: {
      '@aalis/core': 'latest',
      typescript: '^5.7.0',
      '@types/node': '^22.0.0',
    },
    // 有服务依赖/提供时在此声明，市场据此做安装前能力披露：
    // aalis: { service: { required: ['llm'], optional: ['memory'], provides: ['my-service'] } }
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

function renderTsconfig(): string {
  // 自包含：不 extends monorepo 的 tsconfig.base.json，独立目录下也能 `tsc` 通过。
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022'],
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        declaration: true,
        resolveJsonModule: true,
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`;
}

function renderIndexTs(a: Answers): string {
  const imports: string[] = [`import type { Context } from '@aalis/core';`];
  if (a.features.tool) imports.push(`import { useToolService } from '@aalis/plugin-tools-api';`);
  if (a.features.command) imports.push(`import { useCommandService } from '@aalis/plugin-commands-api';`);
  if (a.features.webui) {
    imports.push(`import type { WebuiPage } from '@aalis/plugin-webui-api';`);
    imports.push(`import { useWebuiService } from '@aalis/plugin-webui-api';`);
  }

  const body: string[] = [];
  if (a.features.tool) {
    body.push(`  // 注册 AI 可调用的工具
  useToolService(ctx).register({
    definition: {
      type: 'function',
      function: {
        name: 'hello',
        description: '示例工具：返回问候语',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    },
    // handler 必须返回 string（工具结果文本），不是对象
    async handler(args) {
      return \`你好, \${(args as { name: string }).name}!\`;
    },
  });`);
  }
  if (a.features.command) {
    body.push(`  // 注册斜杠命令
  useCommandService(ctx)
    .command('hello', '示例命令')
    .action(async () => '你好');`);
  }
  if (a.features.webui) {
    body.push(`  // 注册 WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);`);
  }

  const webuiPagesBlock = a.features.webui
    ? `
const webuiPages: WebuiPage[] = [
  {
    key: '${shortName(a.packageName).replace(/^plugin-/, '')}',
    label: '${a.displayName}',
    order: 80,
    content: [
      {
        type: 'info',
        label: '示例信息',
        source: 'getInfo',
      },
    ],
  },
];

export const actions = {
  async getInfo() {
    return { 提示: '这是 ${a.displayName} 插件的示例信息面板。' };
  },
};
`
    : '';

  return `${imports.join('\n')}

// ===== 插件元数据 =====

export const name = '${a.packageName}';
export const displayName = '${a.displayName}';
export const inject = {};
${webuiPagesBlock}
export function apply(ctx: Context, _config: Record<string, unknown>): void {
  const logger = ctx.logger.child('${shortName(a.packageName).replace(/^plugin-/, '')}');
  logger.info('插件已加载');

${body.join('\n\n')}
}
`;
}

function renderReadme(a: Answers): string {
  return `# ${a.packageName}

${a.displayName} —— 由 \`create-aalis-plugin\` 生成的 Aalis 插件骨架。

## 启用

把本目录复制到 Aalis 仓库的 \`packages/\` 下，然后在 \`aalis.config.yaml\` 的 \`plugins\` 段加上：

\`\`\`yaml
plugins:
  "${a.packageName}":
    enabled: true
\`\`\`

## 扩展点

${a.features.tool ? '- ✓ 注册 AI 工具（\\`useToolService\\`）\n' : ''}${a.features.command ? '- ✓ 注册斜杠命令（\\`useCommandService\\`）\n' : ''}${a.features.webui ? '- ✓ WebUI 页面（\\`useWebuiService\\`）\n' : ''}
请打开 \`src/index.ts\` 按需修改。
`;
}

// 仅在作为 CLI 直接执行时运行 main；被 import（单测纯函数）时不自动跑。
// 用 realpath 比较两侧：经 .bin 软链调用时 argv[1] 是软链路径，直接比 import.meta.url 会不相等。
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

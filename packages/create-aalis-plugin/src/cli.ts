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
    console.log('\n要让 Aalis 加载它：在你的 Aalis 项目目录里执行 `npm install --install-links <本目录路径>`，');
    console.log('并在该项目的 .npmrc 写 `install-links=true`（否则下次普通 npm install 会改回符号链接）；');
    console.log('pnpm 项目用 `pnpm add file:<本目录路径>`。不能装成符号链接：本目录 devDependencies 里的 @aalis/core');
    console.log('会成为进程里的第二份，插件会被拒绝加载。');
    console.log('装进 dependencies 即被自动发现并加载（插件默认启用；停用是把包名写进 disabledPlugins）。');
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

export function renderPackageJson(a: Answers): string {
  // 运行时依赖：服务描述符是值导入，用到的 api 包进 dependencies；@aalis/core
  // 是宿主必有的核心，走 peerDependencies + devDep。
  // 注意：这里写进的是【生成给外部作者项目】的字面版本，不能用 workspace:（脚手架产物不在
  // 本 monorepo，workspace: 协议在外部装不上）——统一用 'latest'：npm install 时取最新、自我
  // 修正，不硬编码会过时的版本（与 create-aalis 同策略）。
  // core peerDep 的下限是 definePlugin / 服务描述符首次出现的版本；上限放到 1.0 之前，插件不必随
  // core 次版本升级而重发。注意 1.0 之前 core 的公开面可能在次版本被删——用了某版本才有的 API，
  // 就把下限抬到那个版本。稳定性承诺自 1.0 起生效。
  const deps: Record<string, string> = {};
  // 与 renderIndexTs 生成的 uses 对应的服务名
  const optionalServices = [
    ...(a.features.tool ? ['tools'] : []),
    ...(a.features.command ? ['commands'] : []),
    ...(a.features.webui ? ['webui-server'] : []),
  ];
  if (a.features.tool) deps['@aalis/api-tools'] = 'latest';
  if (a.features.command) deps['@aalis/api-commands'] = 'latest';
  if (a.features.webui) deps['@aalis/api-webui'] = 'latest';

  // aalis.service：声明运行时服务依赖/提供，供市场装前披露，须与 definePlugin 的 uses / provides 一致。
  const json: Record<string, unknown> = {
    name: a.packageName,
    version: '0.1.0',
    type: 'module',
    // description / author 供插件市场展示（市场直接读 package.json，不进插件定义）
    description: `${a.displayName} —— Aalis 插件`,
    // keyword 'aalis-plugin' 是加载硬门（加载器只认它，漏写即永不加载），市场检索也按它
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
      '@aalis/core': '>=0.17.0 <1.0.0',
    },
    devDependencies: {
      '@aalis/core': 'latest',
      typescript: '^5.7.0',
      '@types/node': '^22.0.0',
    },
    // 市场据此做安装前能力披露，须与 definePlugin 的 uses / provides 保持一致：
    // { service: { required: ['llm'], optional: ['memory'], provides: ['my-service'] } }
    aalis: { service: { required: ['logger'], ...(optionalServices.length ? { optional: optionalServices } : {}) } },
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

/** 用户勾选 → uses 键 / 描述符。README 与 index 共用，避免一边列了未勾选的能力。 */
interface CapabilityUse {
  usesKey: string;
  descriptor: string;
  importLine: string;
  bullet: string;
}

function selectedCapabilityUses(features: Answers['features']): CapabilityUse[] {
  const out: CapabilityUse[] = [];
  if (features.tool) {
    out.push({
      usesKey: 'tools',
      descriptor: 'optional(tools)',
      importLine: `import { tools } from '@aalis/api-tools';`,
      bullet: '- ✓ 注册 AI 工具（`uses: { tools: optional(tools) }`，从 `@aalis/api-tools` 导入描述符）',
    });
  }
  if (features.command) {
    out.push({
      usesKey: 'commands',
      descriptor: 'optional(commands)',
      importLine: `import { commands } from '@aalis/api-commands';`,
      bullet: '- ✓ 注册斜杠命令（`uses: { commands: optional(commands) }`，从 `@aalis/api-commands` 导入描述符）',
    });
  }
  if (features.webui) {
    out.push({
      usesKey: 'webui',
      descriptor: 'optional(webuiServer)',
      importLine: `import { type WebuiPage, webuiServer } from '@aalis/api-webui';`,
      bullet: '- ✓ WebUI 页面（`uses: { webui: optional(webuiServer) }`，从 `@aalis/api-webui` 导入描述符）',
    });
  }
  return out;
}

function usesObjectLiteral(features: Answers['features']): string {
  const caps = selectedCapabilityUses(features);
  const parts = ['logger', ...caps.map(c => `${c.usesKey}: ${c.descriptor}`)];
  return `{ ${parts.join(', ')} }`;
}

export function renderIndexTs(a: Answers): string {
  // uses 里声明了什么，apply 就只能碰到什么：没有默认注入
  const caps = selectedCapabilityUses(a.features);
  const coreImports = ['definePlugin', 'logger'];
  if (caps.length > 0) coreImports.push('optional');
  const imports: string[] = [
    ...caps.map(c => c.importLine),
    `import { ${coreImports.sort().join(', ')} } from '@aalis/core';`,
  ];

  const params = ['logger', ...caps.map(c => c.usesKey)];
  const body: string[] = [];
  if (a.features.tool) {
    body.push(`    // 注册 AI 可调用的工具。登记随这次激活撤回；tools 服务晚上线或换人时自动重挂
    tools.register({
      // 能力档位：不声明 = public（任意等级 0 用户可经自然语言驱动）。
      // 只读但涉隐私 → risk: 'sensitive'；写/删/执行 → visibility: 'restricted' + confirm: 'session'。
      // 参见 Aalis 安全模型文档 concepts/security-model.md「插件作者怎么标操作风险」。
      definition: {
        type: 'function',
        function: {
          name: 'hello',
          description: '示例工具：返回问候语',
          parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      },
      // handler 返回 string 即纯文本结果；需要把图交给主模型时返回 { content, images }
      async handler(args) {
        return \`你好, \${(args as { name: string }).name}!\`;
      },
    });`);
  }
  if (a.features.command) {
    body.push(`    // 注册斜杠命令
    commands.command('hello', '示例命令').action(async () => '你好');`);
  }
  if (a.features.webui) {
    body.push(`    // 注册 WebUI 页面与它的页面动作（处理函数是闭包，直接用 apply 里的能力）
    for (const page of webuiPages) webui.registerPage(page);
    webui.registerAction('getInfo', async () => ({ 提示: '这是 ${a.displayName} 插件的示例信息面板。' }));`);
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
`
    : '';

  return `${imports.join('\n')}
${webuiPagesBlock}
// 入口必须默认导出 definePlugin 的产物：加载器只认它
export default definePlugin({
  name: '${a.packageName}',
  displayName: '${a.displayName}',
  // 用到的全部能力。可选依赖包一层 optional()：缺席不拦激活，到场后自动接上
  uses: ${usesObjectLiteral(a.features)},
  apply({ ${params.join(', ')} }) {
    logger.info('插件已加载');
${body.length ? `\n${body.join('\n\n')}\n` : ''}  },
});
`;
}

export function renderReadme(a: Answers): string {
  const caps = selectedCapabilityUses(a.features);
  const usesLine = `uses: ${usesObjectLiteral(a.features)}`;
  const bullets = caps.map(c => c.bullet).join('\n');
  return `# ${a.packageName}

${a.displayName} —— 由 \`create-aalis-plugin\` 生成的 Aalis 插件骨架。

## 启用

构建并发布（或 \`npm pack\`）后，在 Aalis 部署目录安装即被自动发现并加载：

\`\`\`bash
npm install ${a.packageName}
\`\`\`

发现机制依赖 package.json 的 \`"keywords": ["aalis-plugin"]\`（脚手架已带，勿删）。
插件默认启用；停用是把包名加入 \`aalis.config.yaml\` 顶层的 \`disabledPlugins\` 数组。
插件配置写在 \`plugins."${a.packageName}"\` 段；没有 \`enabled\` 开关。若你为插件声明了
\`configSchema\`，键与字段以其为准（schema 外字段启动时会被裁剪）。

## 扩展点

入口是 \`export default definePlugin({ uses, apply })\`。用到的服务经描述符导入后写进
\`uses\`（本模板与 \`src/index.ts\` 同源）：

\`${usesLine}\`

${bullets ? `${bullets}\n` : ''}
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

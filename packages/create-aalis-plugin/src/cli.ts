#!/usr/bin/env node
/**
 * Aalis 插件交互式脚手架。
 *
 * 用法：
 *   create-aalis-plugin                 → 交互式 prompts
 *   create-aalis-plugin <name>          → 仅指定名称，其余 prompts
 *   create-aalis-plugin <name> --yes    → 全默认值（tool 模板，无 webui）
 *   --registry <源地址>                  → 查依赖最新版本用的 npm 源（默认官方源）
 *
 * 输出：在 cwd 下创建 `<name>/` 目录，含完整 package.json / tsconfig.json /
 * src/index.ts。依赖的 @aalis 包按源上的最新版写下界。生成完毕后打印下一步命令。
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
    /** WebUI 页面：不要、声明式，或自带前端（插件前端） */
    webui: false | 'declarative' | 'frame';
    /** 登记一个会话设置项 */
    sessionSetting: boolean;
  };
}

/** 依赖的 @aalis 包 → 生成时向源查到的最新版本 */
type Versions = Record<string, string>;

// ── 输入校验（纯函数，便于单测）─────────────────────────────────
// 注：validateNpmName、parseYesNo 与参数解析和 create-aalis 中实现刻意一致——两者都是零运行时依赖的独立脚手架，
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

/** 带取值的 flag：紧随其后的一个 token 是它的值，不当包名 */
const VALUE_FLAGS = new Set(['--registry']);

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) out.push(args[i]);
    else if (VALUE_FLAGS.has(args[i])) i++;
  }
  return out;
}

/** `--registry <值>` 与 `--registry=<值>` 两种写法 */
function argValue(args: string[], flag: string): string | undefined {
  const eq = args.find(a => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 向源查一个包的最新版本；查不到时抛错，写明是哪个包、为什么 */
async function latestVersion(registry: string, pkg: string): Promise<string> {
  const url = `${registry.replace(/\/+$/, '')}/${pkg}/latest`;
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new Error(`查不到 ${pkg} 的最新版本：连不上 ${url}（${(err as Error).message}）`);
  }
  if (!r.ok) throw new Error(`查不到 ${pkg} 的最新版本：${url} 回应 ${r.status}`);
  let body: unknown;
  try {
    body = await r.json();
  } catch (err) {
    throw new Error(`查不到 ${pkg} 的最新版本：${url} 的回应读不出 JSON（${(err as Error).message}）`);
  }
  const version = (body as { version?: unknown } | null)?.version;
  if (typeof version !== 'string') throw new Error(`查不到 ${pkg} 的最新版本：${url} 的回应里没有版本号`);
  return version;
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  const skipPrompts = args.includes('--yes') || args.includes('-y');
  const registry = argValue(args, '--registry') ?? DEFAULT_REGISTRY;
  const cliName = positionalArgs(args)[0];

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
    const tool = await askYesNo('注册 AI 工具？', true);
    const command = await askYesNo('注册斜杠命令？', false);
    const page = await askYesNo('提供 WebUI 页面？', false);
    const frame = page && (await askYesNo('页面用自带前端？', false));
    const sessionSetting = await askYesNo('登记会话设置项？', false);
    const features: Answers['features'] = {
      tool,
      command,
      webui: page && (frame ? 'frame' : 'declarative'),
      sessionSetting,
    };

    const answers: Answers = { packageName, displayName, features };
    const dir = shortName(packageName);
    const targetDir = resolve(process.cwd(), dir);

    if (existsSync(targetDir)) {
      console.error(`目录已存在: ${targetDir}：换一个插件名，或先移走这个目录`);
      exit(1);
    }

    let versions: Versions;
    try {
      const packages = dependencyPackages(features);
      versions = Object.fromEntries(
        await Promise.all(packages.map(async pkg => [pkg, await latestVersion(registry, pkg)])),
      );
    } catch (err) {
      console.error(
        `${(err as Error).message}\n检查网络与代理后重试，或用 --registry <源地址> 指定一个能访问的 npm 源（npm config get registry 可查本机在用的源）。`,
      );
      exit(1);
    }

    await generate(targetDir, answers, versions);

    console.log(`\n✓ 已生成插件骨架: ${targetDir}\n`);
    console.log('下一步：');
    console.log(`  cd ${dir}`);
    console.log('  npm install');
    console.log('  npm run build');
    console.log('\n装进 Aalis 项目：在项目目录里执行 npm install --install-links <本目录路径>，');
    console.log('并在项目的 .npmrc 写一行 install-links=true（否则下次普通 npm install 会改回符号链接）；');
    console.log('或在本目录执行 npm pack，再在项目目录 npm install <生成的 .tgz 路径>。不能装成符号链接：');
    console.log('本目录 devDependencies 里的 @aalis/core 会成为进程里的第二份，插件会被拒绝加载。');
    console.log(
      '装好后重启实例，或在 WebUI 插件区点「重新扫描」，插件才会加载（插件默认启用；停用是把包名写进 disabledPlugins）。',
    );
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

/** 页面的 key：包名最后一段去掉 plugin- 前缀 */
function pageKeyOf(pkg: string): string {
  return shortName(pkg).replace(/^plugin-/, '');
}

/** 示例会话设置项的键：各插件的设置项共用一张表，接上包名免得撞上别的插件 */
function settingKeyOf(pkg: string): string {
  const words = pageKeyOf(pkg)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return `greeting${words.map(w => w[0].toUpperCase() + w.slice(1)).join('')}`;
}

export async function generate(dir: string, a: Answers, versions: Versions): Promise<void> {
  await mkdir(resolve(dir, 'src'), { recursive: true });

  await writeFile(resolve(dir, 'package.json'), renderPackageJson(a, versions));
  await writeFile(resolve(dir, 'tsconfig.json'), renderTsconfig());
  await writeFile(resolve(dir, 'src/index.ts'), renderIndexTs(a));
  await writeFile(resolve(dir, 'README.md'), renderReadme(a));
  if (a.features.webui === 'frame') {
    await mkdir(resolve(dir, 'webui'));
    await writeFile(resolve(dir, 'webui/index.html'), renderFrameHtml(a));
    await writeFile(resolve(dir, 'webui/main.js'), FRAME_SCRIPT);
  }
}

/** 要向源查版本的 @aalis 包：开发依赖 core，加上所选能力的契约包 */
function dependencyPackages(features: Answers['features']): string[] {
  return ['@aalis/core', ...selectedCapabilityUses(features).map(c => c.pkg)];
}

/** 写进依赖的范围：下界是生成时源上的最新版，上界统一到 1.0 之前——0.x 下 caret 跨次版本即断 */
const rangeOf = (version: string) => `>=${version} <1.0.0`;

export function renderPackageJson(a: Answers, versions: Versions): string {
  // 运行时依赖：服务描述符是值导入，用到的 api 包进 dependencies；@aalis/core 是宿主必有的核心，走 peerDependencies + devDep。
  // core peerDep 的下限是 definePlugin / 服务描述符首次出现的版本；上限放到 1.0 之前，插件不必随
  // core 次版本升级而重发。注意 1.0 之前 core 的公开面可能在次版本被删——用了某版本才有的 API，
  // 就把下限抬到那个版本。稳定性承诺自 1.0 起生效。
  const caps = selectedCapabilityUses(a.features);
  const deps = Object.fromEntries(caps.map(c => [c.pkg, rangeOf(versions[c.pkg])]));

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
    // 发布包只含编译产物，以及插件前端的静态网页
    files: ['dist', ...(a.features.webui === 'frame' ? ['webui'] : [])],
    scripts: {
      build: 'tsc',
      dev: 'tsc --watch',
    },
    ...(caps.length ? { dependencies: deps } : {}),
    peerDependencies: {
      '@aalis/core': '>=0.17.0 <1.0.0',
    },
    devDependencies: {
      '@aalis/core': rangeOf(versions['@aalis/core']),
      typescript: '^5.7.0',
      '@types/node': '^22.0.0',
    },
    // 市场据此做安装前能力披露，须与 definePlugin 的 uses / provides 保持一致：
    // { service: { required: ['llm'], optional: ['memory'], provides: ['my-service'] } }
    aalis: {
      service: { required: ['logger'], ...(caps.length ? { optional: caps.map(c => c.service) } : {}) },
    },
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

/** 用户勾选的能力：uses 键、描述符、契约包与服务名。package.json、README 与 index 共用，避免一边列了未勾选的能力 */
interface CapabilityUse {
  usesKey: string;
  /** 契约包导出的描述符 */
  descriptor: string;
  pkg: string;
  service: string;
  /** README 里这一项的说法 */
  what: string;
}

function selectedCapabilityUses(features: Answers['features']): CapabilityUse[] {
  const out: CapabilityUse[] = [];
  if (features.tool) {
    out.push({
      usesKey: 'tools',
      descriptor: 'tools',
      pkg: '@aalis/api-tools',
      service: 'tools',
      what: '注册 AI 工具',
    });
  }
  if (features.command) {
    out.push({
      usesKey: 'commands',
      descriptor: 'commands',
      pkg: '@aalis/api-commands',
      service: 'commands',
      what: '注册斜杠命令',
    });
  }
  if (features.webui) {
    out.push({
      usesKey: 'webui',
      descriptor: 'webuiServer',
      pkg: '@aalis/api-webui',
      service: 'webui-server',
      what: `WebUI 页面${features.webui === 'frame' ? '，自带前端（见下文「插件前端」）' : ''}`,
    });
  }
  if (features.sessionSetting) {
    out.push({
      usesKey: 'sessionManager',
      descriptor: 'sessionManager',
      pkg: '@aalis/api-session-manager',
      service: 'session-manager',
      what: '会话设置项',
    });
  }
  return out;
}

function usesObjectLiteral(features: Answers['features']): string {
  const caps = selectedCapabilityUses(features);
  const parts = ['logger', ...caps.map(c => `${c.usesKey}: optional(${c.descriptor})`)];
  return `{ ${parts.join(', ')} }`;
}

export function renderIndexTs(a: Answers): string {
  // uses 里声明了什么，apply 就只能碰到什么：没有默认注入
  const caps = selectedCapabilityUses(a.features);
  const coreImports = ['definePlugin', 'logger'];
  if (caps.length > 0) coreImports.push('optional');
  const imports: string[] = [
    ...caps.map(c => `import { ${c.descriptor} } from '${c.pkg}';`),
    `import { ${coreImports.sort().join(', ')} } from '@aalis/core';`,
  ];
  const settingKey = settingKeyOf(a.packageName);
  const declarations = a.features.sessionSetting
    ? `
// 会话设置项的值类型：经 declaration merging 加进 SessionConfig，与登记的键对应
declare module '@aalis/api-session-manager' {
  interface SessionConfig {
    ${settingKey}?: string;
  }
}
`
    : '';

  const params = ['logger', ...caps.map(c => c.usesKey)];
  const body: string[] = [];
  if (a.features.tool) {
    const handler = a.features.sessionSetting
      ? `      async handler(args, ctx) {
        // 按这次调用所在的会话读设置项的生效值（会话自己的、平台档与全局默认逐层叠出）；哪层都没设时用默认的问候语
        const greeting = sessionManager.current?.resolveConfig(ctx.sessionId, ctx.platform).${settingKey} ?? '你好';
        return \`\${greeting}, \${(args as { name: string }).name}!\`;
      },`
      : `      async handler(args) {
        return \`你好, \${(args as { name: string }).name}!\`;
      },`;
    body.push(`    // 注册 AI 可调用的工具。登记随这次激活撤回；tools 服务晚上线或换人时自动重挂
    tools.register({
      // 风险档位，决定谁能经自然语言驱动它、要不要确认：只读且不涉隐私写 'safe'，任何人可用；只读但涉隐私写 'sensitive'，
      // 限有权限的用户；写、删、执行写 'dangerous'，限高权限的用户，owner 用也要确认。
      // 参见 Aalis 安全模型文档 concepts/security-model.md「插件作者怎么标操作风险」。
      risk: 'safe',
      // 耗时长、晚些拿到结果仍有用的工具（构建、下载、渲染）可以声明 background: {} 让执行器转后台：handler 要响应
      // ctx.signal 的中止并尽快返回，进度写进 ctx.output。见 Aalis 插件作者指南「长任务与取消」。本示例是即时的，不声明
      definition: {
        type: 'function',
        function: {
          name: 'hello',
          description: '示例工具：返回问候语',
          parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      },
      // handler 返回 string 即纯文本结果；需要把图交给主模型时返回 { content, images }
${handler}
    });`);
  }
  if (a.features.command) {
    body.push(`    // 注册斜杠命令
    commands.command('hello', '示例命令').action(async () => '你好');`);
  }
  const pageKey = pageKeyOf(a.packageName);
  if (a.features.webui === 'declarative') {
    body.push(`    // 登记 WebUI 页面：组件、数据源与动作一次给出，出现在本插件详情里；登记随这次激活撤回
    webui.definePage({
      key: '${pageKey}',
      title: ${JSON.stringify(a.displayName)},
      content: [
        {
          type: 'info',
          id: 'info',
          label: '示例信息',
          data: () => [{ label: '提示', value: ${JSON.stringify(`这是 ${a.displayName} 插件的示例信息面板。`)} }],
        },
      ],
    });`);
  }
  if (a.features.webui === 'frame') {
    body.push(`    // 登记一个自带前端的 WebUI 页面：webui/ 里的静态网页在宿主画的隔离框架里显示，只能经宿主调这里声明的数据源与
    // 动作。出现在本插件详情里；登记随这次激活撤回
    const items = ['示例条目一', '示例条目二', '示例条目三'];
    const page = webui.definePage({
      key: '${pageKey}',
      title: ${JSON.stringify(a.displayName)},
      // 宿主从这个模块往上找到插件包根，托管包根下 webui/ 里的文件
      frame: { module: import.meta.url },
      sources: {
        items: { data: () => items },
      },
      actions: {
        // destructive 的动作由宿主先弹确认框，框里列出这次的输入值
        remove: {
          label: '删除',
          effect: 'destructive',
          confirm: '从列表里删掉这一条？',
          input: { item: { type: 'string', label: '条目', required: true } },
          handler: ({ input }) => {
            const at = items.indexOf(input.item);
            if (at < 0) throw new Error(\`没有这一条：\${input.item}\`);
            items.splice(at, 1);
            // 数据变了：打开着的页面收到通知后重取
            page.invalidate('items');
            return \`已删除 \${input.item}\`;
          },
        },
      },
    });`);
  }
  if (a.features.sessionSetting) {
    body.push(`    // 登记一个会话设置项：出现在会话设置里，各会话、各平台档可以各自设；登记随这次激活撤回，会话管理晚上线时自动补上。
    // 读法：sessionManager.current?.resolveConfig(会话 id, 平台).${settingKey}，哪层都没设时没有这个键
    sessionManager.registerSetting({
      key: '${settingKey}',
      // 字段：类型、标签与说明，写入时按它校验；default 只供界面显示，要与哪层都没设时的行为一致
      field: { type: 'string', label: '问候语', description: '示例设置项：按会话设一个问候语', default: '你好' },
      // 适用的会话种类：owner 是 WebUI 与终端里 owner 的会话，room 是群与私聊，task 是子会话
      appliesTo: ['owner', 'room', 'task'],
      // 显眼程度：composer 放在输入框旁，common 排在设置前面，advanced 收进「高级」
      prominence: 'advanced',
    });`);
  }

  return `${imports.join('\n')}
${declarations}
// 入口必须默认导出 definePlugin 的产物：加载器只认它
export default definePlugin({
  name: '${a.packageName}',
  displayName: ${JSON.stringify(a.displayName)},
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
  const bullets = caps
    .map(c => `- ✓ ${c.what}（\`uses: { ${c.usesKey}: optional(${c.descriptor}) }\`，从 \`${c.pkg}\` 导入描述符）`)
    .join('\n');
  return `# ${a.packageName}

${a.displayName} —— 由 \`create-aalis-plugin\` 生成的 Aalis 插件骨架。

## 构建

\`\`\`bash
npm install
npm run build
\`\`\`

## 装进 Aalis 项目

在 Aalis 项目目录里任选一种：

\`\`\`bash
npm install --install-links <本目录路径>    # 再在项目的 .npmrc 写一行 install-links=true，否则下次 npm install 会改回符号链接
npm install <本目录里 npm pack 生成的 .tgz>  # 先在本目录执行 npm pack
npm install ${a.packageName}                 # 发布到 npm 之后
\`\`\`

不能装成符号链接：本目录 devDependencies 里的 \`@aalis/core\` 会成为进程里的第二份，插件会被拒绝加载。
装好后重启实例，或在 WebUI 插件区点「重新扫描」，插件才会加载。

发现机制依赖 package.json 的 \`"keywords": ["aalis-plugin"]\`（脚手架已带，勿删）。
插件默认启用；停用是把包名加入 \`aalis.config.yaml\` 顶层的 \`disabledPlugins\` 数组。
插件配置写在 \`plugins."${a.packageName}"\` 段；没有 \`enabled\` 开关。若你为插件声明了
\`configSchema\`，键与字段以其为准（schema 外字段启动时会被裁剪）。
读取配置时安装 \`@aalis/schema-config\`（>=0.14.0），用 \`defineConfig\` 定义 schema，
在 apply 开头调用 \`parseConfig(schema, config, logger)\`。\`config\` 与 \`logger\` 都要写进 uses；
后续只读取解析结果。地址、启动参数等字段用 \`onInvalid: 'error'\` 拒绝错误值。

## 扩展点

入口是 \`export default definePlugin({ uses, apply })\`。用到的服务经描述符导入后写进
\`uses\`（本模板与 \`src/index.ts\` 同源）：

\`${usesLine}\`

${bullets ? `${bullets}\n` : ''}
请打开 \`src/index.ts\` 按需修改。
${a.features.webui === 'frame' ? FRAME_README : ''}`;
}

/** 选了自带前端时 README 多的一节 */
const FRAME_README = `
## 插件前端

页面用自带前端：\`webui/\` 里是一份静态网页，宿主把它画在插件详情的页面里一个隔离的框架中。它与宿主页面不同源，
拿不到登录状态，要宿主的数据与动作只能经宿主调 \`src/index.ts\` 里声明的数据源与动作。可以联网，外站的样式、字体、
图片与数据请求都放行；脚本只认 \`webui/\` 里打包的文件，页面里写的内联脚本不执行，框架里也不能再嵌别的网页。

- \`webui/index.html\` 是入口，引用宿主提供的样式基线 \`/frames/_base/frame.css\`（跟随宿主的主题）；
  \`webui/main.js\` 用宿主提供的助手 \`/frames/_base/frame.js\` 握手，取数据源 \`items\`、调动作 \`remove\`。都不用构建。
- \`package.json\` 的 \`files\` 带上了 \`webui\`，发布时一起打包。
- 只有一个文档：页面内的切换只用内存里的状态，不改地址；链接经 \`frame.open({ url })\` 请宿主打开；
  确认交给动作的 \`effect\`；不受信的文本（群成员的昵称与消息、网页标题）用 \`textContent\` 插入，不当 HTML。
- 页面宽度：插件页面跟着主区，会话面板约 340 像素，手机 390 像素，按容器宽度排版；尺寸用 rem，触屏可点区 44 像素。

契约见 Aalis 文档 api-webui 的「插件前端」一节。
`;

/** 插件前端的入口：显示名按 HTML 文本写进标题 */
function renderFrameHtml(a: Answers): string {
  const title = a.displayName
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/frames/_base/frame.css" />
    <script type="module" src="main.js"></script>
  </head>
  <body>
    <p id="status">正在加载…</p>
    <ul id="items"></ul>
  </body>
</html>
`;
}

/** 插件前端的脚本：取数据源 items 列出条目，每条一个「删除」调动作 remove；插件通知数据变了就重取 */
const FRAME_SCRIPT = `// 宿主在隔离的框架里显示这一页：经助手取数据源、调动作，链接经 frame.open 请宿主打开。
// 条目当文本插入（textContent），不当 HTML
import { connect } from '/frames/_base/frame.js';

const frame = await connect();
const list = document.querySelector('#items');
const status = document.querySelector('#status');

function show(error) {
  // 用户在宿主的确认框里取消不算出错
  if (error.code !== 'cancelled') status.textContent = error.message;
}

async function render() {
  const items = await frame.data('items');
  list.replaceChildren(
    ...items.map(item => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = item;
      const remove = document.createElement('button');
      remove.textContent = '删除';
      remove.addEventListener('click', () => frame.action('remove', { item }).catch(show));
      row.append(name, ' ', remove);
      return row;
    }),
  );
  status.textContent = items.length === 0 ? '列表空了' : '';
}

// 插件的数据变了，或宿主重连之后，重取
frame.onInvalidate(() => render().catch(show));
render().catch(show);
`;

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

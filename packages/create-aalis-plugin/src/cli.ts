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

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

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

async function main(): Promise<void> {
  const args = argv.slice(2);
  const skipPrompts = args.includes('--yes') || args.includes('-y');
  const positional = args.filter(a => !a.startsWith('-'));
  const cliName = positional[0];

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def?: string): Promise<string> => {
    if (skipPrompts && def !== undefined) return def;
    const suffix = def !== undefined ? ` (${def})` : '';
    const ans = (await rl.question(`${q}${suffix}: `)).trim();
    return ans || def || '';
  };
  const askYesNo = async (q: string, def = true): Promise<boolean> => {
    if (skipPrompts) return def;
    const ans = (await ask(q, def ? 'Y/n' : 'y/N')).toLowerCase();
    if (!ans || ans === 'y/n'.slice(0, ans.length)) return def;
    return ans === 'y' || ans === 'yes' || ans === 'true';
  };

  try {
    const packageName = cliName ?? (await ask('包名（如 my-plugin 或 @scope/my-plugin）', 'aalis-plugin-sample'));
    if (!packageName) {
      console.error('包名不能为空');
      exit(1);
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
  const deps: Record<string, string> = {
    '@aalis/core': 'workspace:*',
  };
  if (a.features.tool) deps['@aalis/plugin-tools-api'] = 'workspace:*';
  if (a.features.command) deps['@aalis/plugin-commands-api'] = 'workspace:*';
  if (a.features.webui) deps['@aalis/plugin-webui-api'] = 'workspace:*';

  const json = {
    name: a.packageName,
    version: '0.1.0',
    type: 'module',
    // description / author 供插件市场展示（市场直接读 package.json，不入 PluginModule）
    description: `${a.displayName} —— Aalis 插件`,
    // keyword 'aalis-plugin' 是市场发现约定：npm registry 按此 keyword 检索可装插件
    keywords: ['aalis-plugin'],
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    scripts: {
      build: 'tsc',
      dev: 'tsc --watch',
    },
    dependencies: deps,
    devDependencies: {
      typescript: '^5.7.0',
      '@types/node': '^22.0.0',
    },
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

function renderTsconfig(): string {
  return `${JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: { outDir: 'dist', rootDir: 'src' },
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
      name: 'hello',
      description: '示例工具：返回问候语',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    async handler(args) {
      return { text: \`你好, \${(args as { name: string }).name}!\` };
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

main().catch(err => {
  console.error(err);
  exit(1);
});

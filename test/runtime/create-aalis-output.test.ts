import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultPicks,
  describeInstallFailure,
  installFailureKind,
  ollamaSteps,
  renderNextSteps,
  renderReadme,
} from '../../packages/create-aalis/src/cli.js';
import embeddingOllama from '../../packages/plugin-embedding-ollama/src/index.js';
import { npmFailureKind } from '../../packages/plugin-package-manager/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { defaultsFrom } from '../../packages/schema-config/src/index.js';

// create-aalis 交给用户的文字：生成的 README、结尾的「下一步」与 npm install 失败时的修法，都要与实际一致。

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/create-aalis/src/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');

const WEBUI = '@aalis/plugin-webui-server';
const DEEPSEEK = '@aalis/plugin-llm-deepseek';
const OLLAMA = '@aalis/plugin-llm-ollama';
const OLLAMA_EMBEDDING = '@aalis/plugin-embedding-ollama';
const LOG = '/home/someone/.npm/_logs/2026-10-09T00_00_00_000Z-debug-0.log';
const logLine = `npm error A complete log of this run can be found in: ${LOG}`;

describe('生成的 README', () => {
  it('WebUI 地址取 webui-server 的默认监听地址与端口', () => {
    const { host, port } = defaultsFrom(webuiServer.configSchema);
    expect(renderReadme('demo', new Set([WEBUI]))).toContain(`http://${host}:${port}`);
  });

  it('装更多插件：写明运行中的实例要重启或在 WebUI 插件区点「重新扫描」才加载；指向文档站的第一次运行与安装排障', () => {
    const readme = renderReadme('demo', new Set([WEBUI]));
    expect(readme).toContain('重启');
    expect(readme).toContain('重新扫描');
    expect(readme).not.toContain('自动发现加载');
    expect(readme).toContain('https://aalis.acenyan.com/guide/first-run');
    expect(readme).toContain('https://aalis.acenyan.com/guide/troubleshooting');
    expect(renderReadme('demo', new Set([DEEPSEEK]))).not.toContain('重新扫描');
  });
});

describe('结尾的「下一步」', () => {
  it('点名没填的密钥是哪个插件的哪个键、去哪填；粘贴过的不列', () => {
    const enabled = new Set([WEBUI, DEEPSEEK, '@aalis/plugin-embedding-openai']);
    const text = renderNextSteps({
      dir: 'my-bot',
      installed: true,
      enabled,
      keys: { [DEEPSEEK]: { apiKey: 'sk-x' } },
      ollama: [],
      tier: 'standard',
    });
    expect(text).toContain('@aalis/plugin-embedding-openai 的 apiKey');
    expect(text).not.toContain(`${DEEPSEEK} 的 apiKey`);
    expect(text).not.toContain('sk-x');
    expect(text).toContain('WebUI');
    expect(text).toContain('home/aalis.config.yaml');
    expect(text).toContain('cd my-bot');
    expect(text).toContain('npm start');
  });

  it('没装 WebUI 时只指向配置文件；跳过安装时先 npm install；都填了不列密钥', () => {
    const text = renderNextSteps({
      dir: 'my-bot',
      installed: false,
      enabled: new Set([DEEPSEEK]),
      keys: {},
      ollama: [],
      tier: 'minimal',
    });
    expect(text).toContain('cd my-bot && npm install');
    expect(text).not.toContain('WebUI');
    expect(text).toContain(`${DEEPSEEK} 的 apiKey`);
    const filled = renderNextSteps({
      dir: 'my-bot',
      installed: true,
      enabled: new Set([DEEPSEEK]),
      keys: { [DEEPSEEK]: { apiKey: 'sk-x' } },
      ollama: [],
      tier: 'minimal',
    });
    expect(filled).not.toContain('apiKey');
  });

  it('full 档：点名的密钥不是全部，另写其余要填的插件启动后在「需要处理」里列出；别的档不写', () => {
    const next = (tier: 'full' | 'standard') =>
      renderNextSteps({
        dir: 'my-bot',
        installed: true,
        enabled: new Set([DEEPSEEK, WEBUI]),
        keys: {},
        ollama: [],
        tier,
      });
    expect(next('full')).toContain(`${DEEPSEEK} 的 apiKey`);
    expect(next('full')).toContain('其余要填凭据、地址或路径的插件');
    expect(next('standard')).not.toContain('其余要填');
  });

  it('Ollama：没有对话模型时先 ollama pull 一个；语义记忆用它时先拉 embedding 模型（与插件的默认模型一致）', () => {
    const { model } = defaultsFrom(embeddingOllama.configSchema);
    const picks = defaultPicks('standard', true);
    expect(picks.chat).toBe(OLLAMA);
    expect(picks.semantic?.embedding).toBe(OLLAMA_EMBEDDING);
    const empty = ollamaSteps(picks, { base: 'http://127.0.0.1:11434', models: [], chat: false });
    expect(empty.join('\n')).toContain('ollama pull <对话模型名>');
    expect(empty.join('\n')).toContain(`ollama pull ${model}`);
    // 只拉了 embedding 模型：语义记忆的有了，对话模型照样要拉
    expect(ollamaSteps(picks, { base: 'http://127.0.0.1:11434', models: [`${model}:latest`], chat: false })).toEqual([
      'ollama pull <对话模型名>    # 先拉一个对话模型',
    ]);
    expect(
      ollamaSteps(picks, { base: 'http://127.0.0.1:11434', models: ['qwen3:8b', `${model}:latest`], chat: true }),
    ).toEqual([]);
    // 没探到 Ollama 却选了它：不知道里面有什么，照样提示
    expect(ollamaSteps(picks, null)).toHaveLength(2);
    expect(ollamaSteps(defaultPicks('standard', false), null)).toEqual([]);
  });
});

describe('npm install 失败的修法', () => {
  // 类别与插件市场（plugin-package-manager）认的同一套：同一段输出两边认成同一类，修法各写各的
  const cases: Array<[kind: string, stderr: string, advice: string]> = [
    [
      'network',
      [
        'npm error code ENOTFOUND',
        'npm error network request to https://registry.npmjs.org/@aalis%2fcore failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
      ].join('\n'),
      '连不上 npm 源（ENOTFOUND）',
    ],
    ['network', 'npm error code ETIMEDOUT\nnpm error network request failed', 'npm config set registry'],
    ['network', 'npm error code ECONNRESET\nnpm error network aborted', 'npm config set registry'],
    [
      'missing',
      "npm error code E404\nnpm error 404 Not Found - GET https://registry.example.com/@aalis%2fplugin-foo\nnpm error 404  '@aalis/plugin-foo@^0.1.0' is not in this registry.",
      '源上没有这个包或这个版本（E404）',
    ],
    [
      'missing',
      "npm error code ETARGET\nnpm error notarget No matching version found for @aalis/plugin-foo@^0.12.0.\nnpm error notarget In most cases you or one of your dependencies are requesting\nnpm error notarget a package version that doesn't exist.",
      '镜像源时，刚发布的版本可能还没同步',
    ],
    [
      'permission',
      'npm error code EACCES\nnpm error syscall mkdir\nnpm error path /home/someone/.npm/_cacache',
      '不要用 sudo',
    ],
    ['disk', 'npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device, write', '磁盘空间'],
    [
      'native',
      [
        'npm error code 1',
        'npm error path /home/someone/my-bot/node_modules/some-native',
        'npm error command failed',
        'npm error command sh -c prebuild-install || node-gyp rebuild --release',
        'npm error gyp ERR! find Python',
      ].join('\n'),
      '原生模块 some-native 编译失败',
    ],
    [
      'native',
      [
        'npm ERR! code 1',
        'npm ERR! path /home/someone/my-bot/node_modules/@scope/old-native',
        'npm ERR! command failed',
        'npm ERR! gyp ERR! stack Error: not found: make',
      ].join('\n'),
      '原生模块 @scope/old-native 编译失败',
    ],
    [
      'platform',
      'npm error code EBADPLATFORM\nnpm error notsup Unsupported platform for @lancedb/lancedb-darwin-arm64@0.27.1: wanted {"os":"darwin","cpu":"arm64"} (current: {"os":"darwin","cpu":"x64"})',
      '@lancedb/lancedb-darwin-arm64',
    ],
    [
      'browser',
      [
        'npm error code 1',
        'npm error path /home/someone/my-bot/node_modules/puppeteer',
        'npm error command failed',
        'npm error command sh -c node install.mjs',
        'npm error ERROR: Failed to set up chrome v131.0.6778.204! Set "PUPPETEER_SKIP_DOWNLOAD" env variable to skip download.',
        'npm error Error: read ECONNRESET',
      ].join('\n'),
      'PUPPETEER_CHROME_DOWNLOAD_BASE_URL',
    ],
    ['peer', 'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree', '/issues'],
  ];

  it.each(cases)('%s：认出类别（与插件市场相同），给出这一类的修法、重试命令与日志位置', (kind, stderr, advice) => {
    const output = `npm warn deprecated x@1.0.0\n${stderr}\n${logLine}\n`;
    expect(installFailureKind(output)).toBe(kind);
    expect(npmFailureKind(output), '插件市场认的类别').toBe(kind);
    const text = describeInstallFailure(output, 'my-bot');
    expect(text).toContain(advice);
    expect(text).toContain('cd my-bot && npm install');
    expect(text).toContain(LOG);
  });

  it('认不出的：两边都认不出，照旧给重试命令、日志位置与安装排障页', () => {
    const output = `npm error code EUNKNOWNTHING\nnpm error something odd\n${logLine}\n`;
    expect(installFailureKind(output)).toBeUndefined();
    expect(npmFailureKind(output)).toBeUndefined();
    const text = describeInstallFailure(output, 'my-bot');
    expect(text).toContain('cd my-bot && npm install');
    expect(text).toContain(LOG);
    expect(text).toContain('https://aalis.acenyan.com/guide/troubleshooting');
  });
});

describe('create-aalis 装依赖失败', () => {
  let dir: string;
  let registry: Server;
  afterEach(async () => {
    registry.closeAllConnections();
    await new Promise<void>(resolve => registry.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('npm 的报错照常显示在终端，随后写明是哪一类、怎么修，退出码 1', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aalis-install-fail-'));
    registry = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.startsWith('/-/v1/search') ? { objects: [] } : { version: '0.17.0' }));
    });
    await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    if (!address || typeof address === 'string') throw new Error('未监听 TCP');
    // 假的 npm：只往 stderr 写一段断网的报错，退出码 1
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'npm'),
      `#!/bin/sh\nprintf 'npm error code ENOTFOUND\\nnpm error network getaddrinfo ENOTFOUND registry.npmjs.org\\n${logLine}\\n' >&2\nexit 1\n`,
    );
    chmodSync(join(bin, 'npm'), 0o755);
    const failure = await run(
      process.execPath,
      ['--import', tsx, cli, 'my-bot', '--yes', '--registry', `http://127.0.0.1:${address.port}`],
      {
        cwd: dir,
        timeout: 10_000,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, OLLAMA_HOST: '127.0.0.1:9' },
      },
    ).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain('npm error code ENOTFOUND');
    expect(failure?.stderr).toContain('npm config set registry');
    expect(failure?.stderr).toContain(LOG);
    expect(existsSync(join(dir, 'my-bot', 'package.json')), '项目文件已经生成，重试只要再装一次').toBe(true);
  });
});

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  askPicks,
  CHAT_MODELS,
  defaultPicks,
  EMBEDDINGS,
  lancedbSupported,
  MEMORY_BACKENDS,
  type Picks,
  PLATFORMS,
  type Prompter,
  pluginSet,
  VECTORSTORES,
} from '../../packages/create-aalis/src/cli.js';

const run = promisify(execFile);
const PACKAGES = fileURLToPath(new URL('../../packages/', import.meta.url));

/** core 内置六项，以及宿主（@aalis/runtime 与 App）在根上登记的四项 */
const HOST_SERVICES = new Set([
  'events',
  'lifecycle',
  'logger',
  'config',
  'provide',
  'services',
  'app',
  'plugins',
  'host-config',
  'host-paths',
  'plugin-source',
]);

interface Manifest {
  keywords?: string[];
  aalis?: { service?: { provides?: string[]; required?: string[] } };
}
const manifestOf = (name: string): Manifest =>
  JSON.parse(readFileSync(`${PACKAGES}${name.replace('@aalis/', '')}/package.json`, 'utf-8'));

/** 这一组插件提供的服务 */
const servicesOf = (plugins: Iterable<string>) =>
  new Set([...plugins].flatMap(name => manifestOf(name).aalis?.service?.provides ?? []));

/** 装进来的插件里，required 服务既不由档内插件提供、也不由宿主提供的 → `插件: 服务` */
function unmetRequirements(plugins: Iterable<string>): string[] {
  const list = [...plugins].filter(name => (manifestOf(name).keywords ?? []).includes('aalis-plugin'));
  const provided = new Set(HOST_SERVICES);
  for (const name of list) for (const svc of manifestOf(name).aalis?.service?.provides ?? []) provided.add(svc);
  return list.flatMap(name =>
    (manifestOf(name).aalis?.service?.required ?? []).filter(svc => !provided.has(svc)).map(svc => `${name}: ${svc}`),
  );
}
const cli = fileURLToPath(new URL('../../packages/create-aalis/src/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');

const names = (options: ReadonlyArray<{ name: string }>) => options.map(o => o.name);
/** 非空子集 */
const subsets = <T>(items: readonly T[]): T[][] =>
  Array.from({ length: 2 ** items.length - 1 }, (_, mask) => items.filter((_, i) => (mask + 1) & (1 << i)));

/** 默认流程的回答：对话模型、平台、要不要语义记忆；密钥都跳过 */
const answering = (a: { chat: string; platforms: string[]; semantic: boolean }): Prompter => ({
  text: async () => {
    throw new Error('默认流程不问文字');
  },
  choose: async (_title, options) => options.find(o => o.name === a.chat)!,
  chooseMany: async () => a.platforms,
  confirm: async () => a.semantic,
  secret: async () => '',
  close() {},
});

const WEBUI = '@aalis/plugin-webui-server';
const SERPER = '@aalis/plugin-websearch-serper';
const LANCEDB = '@aalis/plugin-vectorstore-lancedb';

describe('create-aalis 生成的项目', () => {
  it.each(['minimal', 'standard'])('%s 档：真 CLI 生成文件，安装并启用归档和记忆后端，依赖闭合', async tier => {
    const dir = await mkdtemp(join(tmpdir(), 'aalis-tier-'));
    // 真 CLI 生成文件；只将 npm 元数据替换为本地响应，不依赖网络或发布状态。
    const registry = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.startsWith('/-/v1/search') ? { objects: [] } : { version: '0.17.0' }));
    });
    try {
      await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
      const address = registry.address();
      if (!address || typeof address === 'string') throw new Error('本地 registry 未监听 TCP');
      await run(
        process.execPath,
        [
          '--import',
          tsx,
          cli,
          'my-bot',
          '--tier',
          tier,
          '--no-install',
          '--registry',
          `http://127.0.0.1:${address.port}`,
        ],
        // Ollama 探测指向没人监听的端口：不碰本机真的 Ollama
        { cwd: dir, timeout: 10_000, env: { ...process.env, OLLAMA_HOST: '127.0.0.1:9' } },
      );
      const pkg = JSON.parse(await readFile(join(dir, 'my-bot', 'package.json'), 'utf-8'));
      expect(pkg.engines, '生成的项目与脚手架要求同一个最低 Node 版本').toEqual({ node: '>=24.15.0' });
      const home = join(dir, 'my-bot', 'home');
      const config = parse(await readFile(join(home, 'aalis.config.yaml'), 'utf-8'));
      // 家目录生成时就是初始化过的：配置与空的密钥文件都在，权限收紧
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, 'secrets.yaml'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, 'aalis.config.yaml'))).mode & 0o777).toBe(0o600);
      const entry = await readFile(join(dir, 'my-bot', 'index.mjs'), 'utf-8');
      expect(entry).toContain("startAalis({ appDir: here, defaultHome: join(here, 'home') })");
      const ignored = (await readFile(join(dir, 'my-bot', '.gitignore'), 'utf-8')).split('\n');
      expect(ignored, '配置、密钥与数据都在家目录里，必须忽略').toContain('home/');
      for (const name of [
        '@aalis/plugin-agent',
        '@aalis/plugin-memory-sqlite',
        '@aalis/plugin-message-archive',
        '@aalis/plugin-hooks',
        '@aalis/plugin-contributions',
      ]) {
        expect(pkg.dependencies[name], name).toBe('^0.17.0');
        // 无配置的已安装插件由 runtime 自动发现，不需要空配置桩。
        expect(config.disabledPlugins).not.toContain(name);
      }
      // 钩子与贡献点不再内置，漏装它们的提供者这里就会点名 gateway / agent 等。
      expect(unmetRequirements(Object.keys(pkg.dependencies)), `${tier} 档依赖不闭合`).toEqual([]);
    } finally {
      registry.closeAllConnections();
      await new Promise<void>((resolve, reject) => registry.close(error => (error ? reject(error) : resolve())));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('full 档：源的插件检索回 200 却是 0 条（镜像源多不支持检索）时提示是哪个源、怎么重试，不静默少装', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aalis-tier-'));
    const registry = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.startsWith('/-/v1/search') ? { objects: [] } : { version: '0.17.0' }));
    });
    try {
      await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
      const address = registry.address();
      if (!address || typeof address === 'string') throw new Error('本地 registry 未监听 TCP');
      const source = `http://127.0.0.1:${address.port}`;
      const { stderr } = await run(
        process.execPath,
        ['--import', tsx, cli, 'my-bot', '--tier', 'full', '--no-install', '--registry', source],
        { cwd: dir, timeout: 10_000, env: { ...process.env, OLLAMA_HOST: '127.0.0.1:9' } },
      );
      expect(stderr).toContain(source);
      expect(stderr).toContain('--registry https://registry.npmjs.org');
    } finally {
      registry.closeAllConnections();
      await new Promise<void>((resolve, reject) => registry.close(error => (error ? reject(error) : resolve())));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('版本一律问注册表的 latest：检索索引还报旧版本时，写进项目的也是注册表上的最新版', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aalis-tier-'));
    const registry = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const stale = { objects: [{ package: { name: '@aalis/plugin-tool-math', version: '0.10.1' } }] };
      response.end(JSON.stringify(request.url?.startsWith('/-/v1/search') ? stale : { version: '0.11.0' }));
    });
    try {
      await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
      const address = registry.address();
      if (!address || typeof address === 'string') throw new Error('本地 registry 未监听 TCP');
      await run(
        process.execPath,
        [
          '--import',
          tsx,
          cli,
          'my-bot',
          '--tier',
          'full',
          '--no-install',
          '--registry',
          `http://127.0.0.1:${address.port}`,
        ],
        { cwd: dir, timeout: 10_000, env: { ...process.env, OLLAMA_HOST: '127.0.0.1:9' } },
      );
      const pkg = JSON.parse(await readFile(join(dir, 'my-bot', 'package.json'), 'utf-8'));
      expect(pkg.dependencies['@aalis/plugin-tool-math']).toBe('^0.11.0');
    } finally {
      registry.closeAllConnections();
      await new Promise<void>((resolve, reject) => registry.close(error => (error ? reject(error) : resolve())));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['minimal', 'standard'] as const)('%s 档：带上会话协议与审批服务的提供者', tier => {
    const provided = servicesOf(pluginSet({ tier, picks: defaultPicks(tier, false) }, true));
    // 没有审批服务时，需要确认的工具调用一律被拒；WebUI 的会话也要经会话协议才连得上
    expect(provided.has('approvals'), '审批').toBe(true);
    expect(provided.has('session-protocol'), '会话协议').toBe(true);
  });

  it('standard 与 full 档带上触及服务的提供者（本地工具要它签发凭据）', () => {
    const standard = pluginSet({ tier: 'standard', picks: defaultPicks('standard', false) }, true);
    expect(servicesOf(standard).has('reach')).toBe(true);
    expect(servicesOf(pluginSet({ tier: 'full', catalog: null }, true)).has('reach')).toBe(true);
  });

  it('默认流程：对话模型三选一 × 平台组合 × 语义记忆要或不要 × 探到或没探到 Ollama，依赖都闭合', async () => {
    const broken: string[] = [];
    let checked = 0;
    for (const ollama of [false, true]) {
      for (const chat of names(CHAT_MODELS)) {
        for (const platforms of subsets(names(PLATFORMS))) {
          for (const semantic of [false, true]) {
            const { picks } = await askPicks(answering({ chat, platforms, semantic }), {
              tier: 'standard',
              advanced: false,
              ollama,
              lancedb: true,
            });
            checked++;
            const unmet = unmetRequirements(pluginSet({ tier: 'standard', picks }, true));
            if (unmet.length > 0) broken.push(`${JSON.stringify(picks)} → ${unmet.join('，')}`);
          }
        }
      }
    }
    expect(checked).toBe(2 * 3 * 7 * 2);
    expect(broken).toEqual([]);
  });

  it('--advanced 的选项：记忆后端、embedding、向量库任选其一，minimal 与 standard 依赖都闭合', () => {
    const broken: string[] = [];
    for (const memory of names(MEMORY_BACKENDS)) {
      for (const embedding of names(EMBEDDINGS)) {
        for (const vectorstore of names(VECTORSTORES)) {
          const picks: Picks = { ...defaultPicks('standard', false), memory, semantic: { embedding, vectorstore } };
          for (const tier of ['minimal', 'standard'] as const) {
            const unmet = unmetRequirements(pluginSet({ tier, picks }, true));
            if (unmet.length > 0) broken.push(`${tier} ${memory} ${embedding} ${vectorstore} → ${unmet.join('，')}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('默认集不装联网搜索；断网时 full 档仍从离线表装上它与绘图插件', () => {
    expect(pluginSet({ tier: 'standard', picks: defaultPicks('standard', false) }, true).has(SERPER)).toBe(false);
    const offline = pluginSet({ tier: 'full', catalog: null }, true);
    expect(offline.has(SERPER)).toBe(true);
    expect(offline.has('@aalis/plugin-draw')).toBe(true);
  });

  it('断网时 full 档的离线表覆盖仓库里全部可发布的插件（LanceDB 按平台另算）', () => {
    const publishable = readdirSync(PACKAGES).flatMap(dir => {
      const file = join(PACKAGES, dir, 'package.json');
      if (!existsSync(file)) return [];
      const pkg = JSON.parse(readFileSync(file, 'utf-8')) as { name: string; private?: boolean; keywords?: string[] };
      return !pkg.private && pkg.keywords?.includes('aalis-plugin') ? [pkg.name] : [];
    });
    const offline = pluginSet({ tier: 'full', catalog: null }, true);
    expect(publishable.filter(name => !offline.has(name))).toEqual([]);
  });

  it('WebUI 是平台组的一项：standard 档不选它就不装 webui-server，选了带上前端与安装引擎', () => {
    const cliOnly = pluginSet(
      { tier: 'standard', picks: { ...defaultPicks('standard', false), platforms: ['@aalis/plugin-cli'] } },
      true,
    );
    expect(cliOnly.has(WEBUI)).toBe(false);
    expect(cliOnly.has('@aalis/plugin-webui-client')).toBe(false);
    const withWebui = pluginSet({ tier: 'standard', picks: defaultPicks('standard', false) }, true);
    expect(withWebui.has(WEBUI)).toBe(true);
    expect(withWebui.has('@aalis/plugin-webui-client')).toBe(true);
    expect(withWebui.has('@aalis/plugin-package-manager')).toBe(true);
  });

  it('语义记忆：要时多装向量记忆、embedding 与向量库，不要时只少这一组', () => {
    const picks = defaultPicks('standard', false);
    const without = pluginSet({ tier: 'standard', picks }, true);
    const withIt = pluginSet(
      {
        tier: 'standard',
        picks: {
          ...picks,
          semantic: { embedding: '@aalis/plugin-embedding-openai', vectorstore: '@aalis/plugin-vectorstore-flat' },
        },
      },
      true,
    );
    expect([...without].every(name => withIt.has(name))).toBe(true);
    expect([...withIt].filter(name => !without.has(name)).sort()).toEqual([
      '@aalis/plugin-embedding-openai',
      '@aalis/plugin-memory-vector',
      '@aalis/plugin-vectorstore-flat',
    ]);
    expect(
      pluginSet({ tier: 'minimal', picks: defaultPicks('minimal', true) }, true).has('@aalis/plugin-memory-vector'),
    ).toBe(false);
  });

  it('LanceDB 只在有预编译件的平台出现：Intel Mac 上 full 档也不装它', () => {
    expect(lancedbSupported('darwin', 'x64')).toBe(false);
    expect(lancedbSupported('darwin', 'arm64')).toBe(true);
    expect(lancedbSupported('linux', 'x64')).toBe(true);
    expect(lancedbSupported('linux', 'arm64')).toBe(true);
    expect(lancedbSupported('win32', 'x64')).toBe(true);
    expect(pluginSet({ tier: 'full', catalog: [LANCEDB] }, false).has(LANCEDB)).toBe(false);
    expect(pluginSet({ tier: 'full', catalog: null }, true).has(LANCEDB)).toBe(true);
  });

  it('bare 档什么插件都不装', () => {
    expect([...pluginSet({ tier: 'bare' }, true)]).toEqual([]);
  });
});

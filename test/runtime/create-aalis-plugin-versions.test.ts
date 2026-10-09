import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { renderIndexTs, renderPackageJson, renderReadme } from '../../packages/create-aalis-plugin/src/cli.js';

// create-aalis-plugin 生成的依赖写法、工具的风险声明、会话设置项一问，以及给作者的 npm 指引。

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/create-aalis-plugin/src/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');

type Webui = false | 'declarative' | 'frame';
const answers = (features: { tool: boolean; command: boolean; webui: Webui; sessionSetting: boolean }) => ({
  packageName: 'aalis-plugin-demo',
  displayName: '演示',
  features,
});
const ALL = { tool: true, command: true, webui: 'declarative', sessionSetting: true } as const;
const VERSIONS = {
  '@aalis/core': '0.19.1',
  '@aalis/api-tools': '0.9.0',
  '@aalis/api-commands': '0.8.0',
  '@aalis/api-webui': '0.12.0',
  '@aalis/api-session-manager': '0.10.0',
};

/** 与 dep-ranges 守卫同一判据：下界是源上的版本，上界统一 <1.0.0 */
const RANGE = /^>=\d+\.\d+\.\d+ <1\.0\.0$/;

describe('生成的依赖', () => {
  it('@aalis 的依赖、开发依赖与 peer 都写 >=x.y.z <1.0.0，下界取源上查到的版本；没有 latest、workspace: 与 caret', () => {
    const pkg = JSON.parse(renderPackageJson(answers(ALL), VERSIONS));
    const aalis = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].flatMap(deps =>
      Object.entries(deps as Record<string, string>).filter(([name]) => name.startsWith('@aalis/')),
    );
    expect(aalis.length).toBe(6);
    for (const [name, range] of aalis) expect(range, name).toMatch(RANGE);
    expect(pkg.dependencies).toEqual({
      '@aalis/api-tools': '>=0.9.0 <1.0.0',
      '@aalis/api-commands': '>=0.8.0 <1.0.0',
      '@aalis/api-webui': '>=0.12.0 <1.0.0',
      '@aalis/api-session-manager': '>=0.10.0 <1.0.0',
    });
    expect(pkg.devDependencies['@aalis/core']).toBe('>=0.19.1 <1.0.0');
    // peer 的下限是 definePlugin 与服务描述符首次成为公开面的版本：模板没用更新的 core 接口
    expect(pkg.peerDependencies['@aalis/core']).toBe('>=0.17.0 <1.0.0');
    expect(JSON.stringify(pkg)).not.toMatch(/latest|workspace:/);
  });

  it('模板从 core 只取 definePlugin、logger 与 optional：peer 下限 0.17.0 由此成立', () => {
    for (let mask = 0; mask < 8; mask++) {
      for (const webui of [false, 'declarative', 'frame'] as const) {
        const source = renderIndexTs(
          answers({ tool: Boolean(mask & 1), command: Boolean(mask & 2), webui, sessionSetting: Boolean(mask & 4) }),
        );
        const imported = /import \{ ([^}]+) \} from '@aalis\/core';/.exec(source)?.[1].split(', ') ?? [];
        expect(
          imported.every(name => ['definePlugin', 'logger', 'optional'].includes(name)),
          imported.join(),
        ).toBe(true);
      }
    }
  });
});

describe('生成的源码', () => {
  it('示例工具显式声明 risk，注释写明三档各管什么与可转后台的声明', () => {
    const source = renderIndexTs(answers({ tool: true, command: false, webui: false, sessionSetting: false }));
    expect(source).toContain("risk: 'safe',");
    for (const part of ["'sensitive'", "'dangerous'", 'background: {}', 'ctx.signal', 'ctx.output', '长任务与取消']) {
      expect(source).toContain(part);
    }
    expect(source).not.toContain("visibility: 'restricted'");
    expect(source).not.toMatch(/^\s+background:/m);
  });

  it('会话设置项：合并进 SessionConfig、经 sessionManager 登记，适用种类与显眼程度写全；选了工具时工具按会话读它', () => {
    const withTool = renderIndexTs(answers({ tool: true, command: false, webui: false, sessionSetting: true }));
    expect(withTool).toContain("declare module '@aalis/api-session-manager'");
    expect(withTool).toContain('interface SessionConfig');
    expect(withTool).toContain('greetingAalisPluginDemo?: string;');
    expect(withTool).toContain('sessionManager: optional(sessionManager)');
    expect(withTool).toContain('sessionManager.registerSetting({');
    expect(withTool).toContain("appliesTo: ['owner', 'room', 'task'],");
    expect(withTool).toContain("prominence: 'advanced',");
    expect(withTool).toContain('resolveConfig(ctx.sessionId, ctx.platform).greetingAalisPluginDemo');
    const alone = renderIndexTs(answers({ tool: false, command: false, webui: false, sessionSetting: true }));
    expect(alone).toContain('sessionManager.registerSetting({');
    expect(alone).not.toContain('ctx.sessionId');
    const pkg = JSON.parse(renderPackageJson(answers(ALL), VERSIONS));
    expect(pkg.aalis.service.optional).toContain('session-manager');
  });

  it('显示名带单引号与反斜杠：按字符串字面量写进源码，生成的源码没有语法错误，值与输入逐字相同', () => {
    const displayName = "Ace's \\ Tools";
    for (const webui of ['declarative', 'frame'] as const) {
      const source = renderIndexTs({ ...answers({ ...ALL, webui }), displayName });
      const { diagnostics } = ts.transpileModule(source, { reportDiagnostics: true });
      expect(diagnostics?.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')) ?? [], webui).toEqual([]);
      expect(source).toContain(`displayName: ${JSON.stringify(displayName)},`);
      expect(source).toContain(`title: ${JSON.stringify(displayName)},`);
    }
  });

  it('README 用 npm 构建，写明装进实例的两种办法与装好后怎么加载；不提 pnpm', () => {
    const readme = renderReadme(answers(ALL));
    for (const part of [
      'npm install',
      'npm run build',
      'npm install --install-links',
      'install-links=true',
      'npm pack',
      '重新扫描',
    ]) {
      expect(readme).toContain(part);
    }
    expect(readme).not.toContain('pnpm');
  });
});

describe('create-aalis-plugin 查依赖版本', () => {
  let dir: string;
  let registry: Server;
  afterEach(async () => {
    registry.closeAllConnections();
    await new Promise<void>(resolve => registry.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /** 本地假源：missing 里的包回 404，pages 里的包回 200 加一张网页（代理或认证网关的登录页），其余回 0.9.0 */
  async function serve(missing: string[], pages: string[] = []): Promise<string> {
    registry = createServer((request, response) => {
      const name = decodeURIComponent(request.url ?? '')
        .replace(/^\//, '')
        .replace(/\/latest$/, '');
      if (pages.includes(name)) {
        response.setHeader('content-type', 'text/html');
        response.end('<!DOCTYPE html><html><body>请先登录</body></html>');
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (missing.includes(name)) {
        response.statusCode = 404;
        response.end('{"error":"not found"}');
      } else {
        response.end(JSON.stringify({ version: '0.9.0' }));
      }
    });
    await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    if (!address || typeof address === 'string') throw new Error('未监听 TCP');
    return `http://127.0.0.1:${address.port}`;
  }

  it('按 --registry 指定的源查，版本写进依赖；尾提示用 npm', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-plugin-versions-'));
    const url = await serve([]);
    const { stdout } = await run(process.execPath, ['--import', tsx, cli, '--registry', url, 'zz-demo', '--yes'], {
      cwd: dir,
      timeout: 10_000,
    });
    const pkg = JSON.parse(await readFile(join(dir, 'zz-demo', 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toEqual({ '@aalis/api-tools': '>=0.9.0 <1.0.0' });
    expect(pkg.devDependencies['@aalis/core']).toBe('>=0.9.0 <1.0.0');
    expect(stdout).toContain('npm install');
    expect(stdout).toContain('npm run build');
    expect(stdout).toContain('重新扫描');
    expect(stdout).not.toContain('pnpm');
  });

  it('查不到版本：退出码 1，写明是哪个包、检查网络或用 --registry 指定源，不生成目录', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-plugin-versions-'));
    const url = await serve(['@aalis/api-tools']);
    const failure = await run(process.execPath, ['--import', tsx, cli, 'zz-demo', '--yes', '--registry', url], {
      cwd: dir,
      timeout: 10_000,
    }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain('@aalis/api-tools');
    expect(failure?.stderr).toContain('--registry');
    expect(existsSync(join(dir, 'zz-demo'))).toBe(false);
  });

  it('源回 200 却读不出 JSON（代理或认证网关的网页）：退出码 1，写明是哪个包、哪个地址，不生成目录', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-plugin-versions-'));
    const url = await serve([], ['@aalis/core']);
    const failure = await run(process.execPath, ['--import', tsx, cli, 'zz-demo', '--yes', '--registry', url], {
      cwd: dir,
      timeout: 10_000,
    }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain(`查不到 @aalis/core 的最新版本：${url}/@aalis/core/latest 的回应读不出 JSON`);
    expect(existsSync(join(dir, 'zz-demo'))).toBe(false);
  });

  it('目标目录已存在：退出码 1，写明怎么办，不动那个目录', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-plugin-versions-'));
    const url = await serve([]);
    await mkdir(join(dir, 'zz-demo'));
    await writeFile(join(dir, 'zz-demo', 'keep.txt'), 'mine');
    const failure = await run(process.execPath, ['--import', tsx, cli, 'zz-demo', '--yes', '--registry', url], {
      cwd: dir,
      timeout: 10_000,
    }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    // 子进程的 cwd 是解析过符号链接的路径（macOS 的临时目录在 /private 下），只核结尾
    expect(failure?.stderr?.trim()).toMatch(/^目录已存在: \/.*\/zz-demo：换一个插件名，或先移走这个目录$/);
    expect(await readdir(join(dir, 'zz-demo'))).toEqual(['keep.txt']);
  });
});

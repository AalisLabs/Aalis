import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GROUPS, MINIMAL_BASE, STANDARD_EXTRA } from '../../packages/create-aalis/src/cli.js';

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
  'plugin-source',
]);

interface Manifest {
  keywords?: string[];
  aalis?: { service?: { provides?: string[]; required?: string[] } };
}
const manifestOf = (name: string): Manifest =>
  JSON.parse(readFileSync(`${PACKAGES}${name.replace('@aalis/', '')}/package.json`, 'utf-8'));

/** 装进来的插件里，required 服务既不由档内插件提供、也不由宿主提供的 → `插件: 服务` */
function unmetRequirements(plugins: string[]): string[] {
  const provided = new Set(HOST_SERVICES);
  for (const name of plugins) for (const svc of manifestOf(name).aalis?.service?.provides ?? []) provided.add(svc);
  return plugins.flatMap(name =>
    (manifestOf(name).aalis?.service?.required ?? []).filter(svc => !provided.has(svc)).map(svc => `${name}: ${svc}`),
  );
}
const cli = fileURLToPath(new URL('../../packages/create-aalis/src/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');

describe('create-aalis 对话模板', () => {
  it.each(['minimal', 'standard'])('%s 生成项目同时安装并启用归档和记忆后端', async tier => {
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
        { cwd: dir, timeout: 10_000 },
      );
      const pkg = JSON.parse(await readFile(join(dir, 'my-bot', 'package.json'), 'utf-8'));
      const config = parse(await readFile(join(dir, 'my-bot', 'aalis.config.yaml'), 'utf-8'));
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
      // 依赖闭包：档内每个插件 required 的服务，要么档内有插件提供，要么是宿主提供的。
      // 钩子与贡献点不再内置，漏装它们的提供者这里就会点名 gateway / agent 等。
      const plugins = Object.keys(pkg.dependencies).filter(name =>
        (manifestOf(name).keywords ?? []).includes('aalis-plugin'),
      );
      expect(unmetRequirements(plugins), `${tier} 档依赖不闭合`).toEqual([]);
    } finally {
      registry.closeAllConnections();
      await new Promise<void>((resolve, reject) => registry.close(error => (error ? reject(error) : resolve())));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['minimal', 'standard'] as const)('%s：任一同类组换选任一组员（其余组取默认），依赖仍闭合', tier => {
    const base = tier === 'minimal' ? [...MINIMAL_BASE] : [...MINIMAL_BASE, ...STANDARD_EXTRA];
    const groups = GROUPS.filter(g => g.tiers.includes(tier));
    const defaultsOf = (g: (typeof groups)[number]) => g.members.filter(m => m.default).map(m => m.name);
    const broken: string[] = [];
    for (const group of groups) {
      const others = groups.filter(g => g !== group).flatMap(defaultsOf);
      for (const member of group.members) {
        const unmet = unmetRequirements([...new Set([...base, ...others, member.name])]);
        if (unmet.length > 0) broken.push(`${group.key}=${member.name} → ${unmet.join('，')}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

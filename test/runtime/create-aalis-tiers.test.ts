import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const run = promisify(execFile);
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
      for (const name of ['@aalis/plugin-agent', '@aalis/plugin-memory-sqlite', '@aalis/plugin-message-archive']) {
        expect(pkg.dependencies[name], name).toBe('^0.17.0');
        // 无配置的已安装插件由 runtime 自动发现，不需要空配置桩。
        expect(config.disabledPlugins).not.toContain(name);
      }
    } finally {
      registry.closeAllConnections();
      await new Promise<void>((resolve, reject) => registry.close(error => (error ? reject(error) : resolve())));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

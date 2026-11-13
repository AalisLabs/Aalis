import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { App, definePlugin, type Logger } from '../../packages/core/src/index.js';
import { createConfigStore, installHostConfig } from '../../packages/runtime/src/config-store.js';
import { installConfigHotReload } from '../../packages/runtime/src/config-sync.js';
import { createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';
import { atomicWrite, settle, waitFor } from '../helpers/fs-watch.js';

// ════════════════════════════════════════════════════════════
// 热重载里的配置同步在变更处理器同步执行的那一段里就保存：补回 schema 默认值，随即落盘。
// 这次保存比对盘上内容与文件层「最后读入」的那份，所以文件层要在调用处理器之前把这份新内容记为已读入；
// 等处理器返回才记，盘上的新内容就被当成尚未生效的外部修改，保存被拒，补回的默认值留不住。
// ════════════════════════════════════════════════════════════

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('热重载里配置同步补回的默认值随这次读入落盘，保存不被当成外部修改拒掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-hot-sync-save-'));
  dirs.push(dir);
  const path = join(dir, 'aalis.config.yaml');
  writeFileSync(path, 'logLevel: error\nplugins:\n  zz-p:\n    a: 1\n    b: 2\n');
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const { config, provider } = createFsYamlConfigProvider(path);
  const store = createConfigStore(config, provider);
  const app = new App({ logLevel: 'error', logger });
  apps.push(app);
  installHostConfig(app, store);
  const definition = definePlugin({
    name: 'zz-p',
    configSchema: { a: { type: 'number', label: 'A', default: 1 }, b: { type: 'number', label: 'B', default: 2 } },
    apply() {},
  });
  await app.pluginAll([{ definition, instanceId: 'zz-p', config: store.getPluginConfig('zz-p') }]);
  await app.start();
  installConfigHotReload(app, store, { registerConfiguredInstances: async () => {} });
  await settle();

  // 手改删掉 b：热重载按 schema 补回 b 的默认值并落盘
  atomicWrite(path, 'logLevel: error\nplugins:\n  zz-p:\n    a: 5\n');
  expect(await waitFor(() => /b: 2/.test(readFileSync(path, 'utf-8')))).toBe(true);
  expect(readFileSync(path, 'utf-8')).toContain('a: 5');
  expect(warnings.filter(line => line.includes('未落盘'))).toEqual([]);
});

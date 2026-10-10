import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { webuiClient } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, type Logger, provide, services } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// webui-server 在 app:ready 时把扫描到的前端包登记成 webui-client 的条目。bounce 后 sticky 的 app:ready 在新实例
// 激活途中补发，登记要等插件状态机静置之后，落在这次激活的 provides 核对之后，与冷启动一样；
// 主动 provide webui-client 的插件仍先于扫描到的包登记，默认胜出。

const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`等待超时: ${what}`);
}

it('bounce 与冷启动一样：扫描到的前端不报「未在 provides 中声明」，主动覆盖仍是胜者', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-webui-bounce-'));
  dirs.push(dir);
  const pkg = join(dir, 'packages', 'zz-client');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'zz-client', aalis: { client: true } }));
  writeFileSync(join(pkg, 'dist', 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zz-app' }));

  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args) => void warnings.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logger, devMode: true });
  apps.push(app);
  provideHostPaths(app, dir);
  await app.plugin(webuiServer, { port: 0, host: '127.0.0.1', autoOpen: false, tokenMode: 'ephemeral' });
  await app.plugin(
    definePlugin({
      name: 'zz-override',
      provides: [webuiClient],
      uses: { provide },
      apply: ({ provide }) => void provide(webuiClient, { getClientDir: () => dir }),
    }),
  );
  await app.plugins.idle();
  await app.start();
  const lookup = app.bind({ services }).services;
  const entries = () => lookup.all(webuiClient).map(view => view.contextId);
  await until(() => entries().includes('zz-client'), '冷启动登记扫描到的前端');

  expect(await app.plugins.bounce(webuiServer.name)).toBe(true);
  await app.plugins.idle();
  await until(() => entries().includes('zz-client'), 'bounce 后重新登记扫描到的前端');

  expect(warnings.filter(text => text.includes('未在 provides 中声明'))).toEqual([]);
  expect(entries()).toEqual(['zz-override', 'zz-client']);
  expect(lookup.get(webuiClient)?.getClientDir(), '主动覆盖仍是胜者').toBe(dir);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, LogHub } from '../../packages/core/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// app:ready 监听器先等插件状态机静置，再登记前端、listen。实例在这段等待里被关掉（bounce、disable），醒来时不能再
// 登记与监听：否则它成了占着端口的旧实例，接手的新实例 listen 报 EADDRINUSE，禁用之后端口照样应答。
// 用一个 apply 睡一会儿的插件把 bounce 之后的重算拉长，在新实例等静置期间再关掉它。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const id = webuiServerPlugin.name;

async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/auth/status`);
    return true;
  } catch {
    return false;
  }
}

describe('webui-server：等静置期间被关掉的实例醒来不再登记与监听', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  async function start() {
    const home = mkdtempSync(join(tmpdir(), 'aalis-webui-ready-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    // 一份扫得到的前端：醒来的旧实例若照常登记，会撞上「已 dispose，忽略 provide」
    const client = join(home, 'packages', 'fake-client');
    mkdirSync(join(client, 'dist'), { recursive: true });
    writeFileSync(join(client, 'package.json'), JSON.stringify({ name: 'fake-client', aalis: { client: true } }));
    writeFileSync(join(client, 'dist', 'index.html'), '<!doctype html><title>fake</title>');

    const port = await freePort();
    const logs: string[] = [];
    const logHub = new LogHub();
    logHub.onEntry(e => {
      if (e.level === 'warn' || e.level === 'error') logs.push(e.message);
    });
    const app = new App({ name: 'T', logLevel: 'warn', logHub });
    cleanups.push(() => app.stop());
    provideHostPaths(app, home);
    await app.pluginAll([{ definition: webuiServerPlugin, config: { port, host: '127.0.0.1', autoOpen: false } }]);
    await app.start();
    await waitListening(port);

    // bounce 之后的重算里，新实例的 app:ready 监听器在等静置；慢插件 apply 期间重算一直不静置
    let slowStarted!: () => void;
    const started = new Promise<void>(r => {
      slowStarted = r;
    });
    const bounced = app.plugins.bounce(id);
    void app.plugin(
      definePlugin({
        name: 'slow',
        async apply() {
          slowStarted();
          await sleep(300);
        },
      }),
    );
    await started;
    return { app, port, logs, bounced };
  }

  it('再 bounce：只有接手的实例在监听，没有 EADDRINUSE，禁用后端口不再应答', async () => {
    const { app, port, logs, bounced } = await start();
    await app.plugins.bounce(id);
    await bounced;
    await app.plugins.idle();
    await waitListening(port);
    await sleep(50);
    expect(logs.filter(m => m.includes('EADDRINUSE') || m.includes('已 dispose'))).toEqual([]);

    await app.plugins.disable(id);
    await app.plugins.idle();
    expect(await answers(port)).toBe(false);
  });

  it('disable：醒来的实例不登记前端、不监听', async () => {
    const { app, port, logs, bounced } = await start();
    await app.plugins.disable(id);
    await bounced;
    await app.plugins.idle();
    await sleep(50);
    expect(await answers(port)).toBe(false);
    expect(logs.filter(m => m.includes('已 dispose'))).toEqual([]);
  });
});

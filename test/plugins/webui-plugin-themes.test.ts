import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import {
  BUILTIN_THEMES,
  type PluginThemesResponse,
  THEME_FILE_FORMAT,
  THEME_FILE_VERSION,
  type ThemeFile,
} from '../../packages/api-webui/src/index.js';
import { App, definePlugin, type Logger } from '../../packages/core/src/index.js';
import contributionsPlugin from '../../packages/plugin-contributions/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 插件经贡献点 webui:theme 提供的主题：webui-server 经 GET /api/themes 列出，与导入的主题走同一套校验（parseTheme），
// 缺的令牌按同种类的偏中性补齐；不合格式的不列出、告警一次；插件停用后随之撤回。真 webui-server、真 HTTP。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-webui-themes-token-placeholder-';
const COOKIE = `aalis_webui_token=${TOKEN}`;
const OWNER = 'zz-theme-pack';

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const theme = (name: string, kind: 'dark' | 'light', colors: ThemeFile['colors']): ThemeFile => ({
  format: THEME_FILE_FORMAT,
  version: THEME_FILE_VERSION,
  name,
  kind,
  colors,
});

/** 主题包：一个只写了两个令牌的深色主题、一个浅色主题，另有一个写了表外令牌的 */
const themePack = definePlugin({
  name: OWNER,
  uses: { contributions },
  apply: ({ contributions }) => {
    contributions.contribute('webui:theme', {
      id: 'dusk',
      theme: theme('黄昏', 'dark', { '--color-bg': '#201a18', '--color-accent': '#c06a3a' }),
    });
    contributions.contribute('webui:theme', { id: 'paper', theme: theme('纸', 'light', { '--color-bg': '#f7f3ea' }) });
    contributions.contribute('webui:theme', {
      id: 'broken',
      theme: { ...theme('坏的', 'dark', {}), colors: { '--color-bg': 'url(https://evil.invalid/x.png)' } },
    });
  },
});

async function setup(options: { hub?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aalis-webui-themes-'));
  homes.push(home);
  const port = await freePort();
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'warn', logger });
  apps.push(app);
  provideHostPaths(app, home);
  await app.pluginAll([
    ...(options.hub === false ? [] : [{ definition: contributionsPlugin }, { definition: themePack }]),
    {
      definition: webuiServerPlugin,
      config: { host: '127.0.0.1', port, autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
    },
  ]);
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  const list = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/themes`, { headers: { cookie: COOKIE } });
    return { status: res.status, body: (await res.json()) as PluginThemesResponse };
  };
  return { app, list, warns };
}

describe('GET /api/themes', () => {
  it('列出插件提供的主题：全局键、提供它的插件实例与补齐了令牌的主题；不合格式的不列出，告警一次', async () => {
    const { list, warns } = await setup();
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.themes.map(entry => [entry.id, entry.instance, entry.theme.name, entry.theme.kind])).toEqual([
      [`${OWNER}/dusk`, OWNER, '黄昏', 'dark'],
      [`${OWNER}/paper`, OWNER, '纸', 'light'],
    ]);
    const [dusk, paper] = body.themes;
    expect(dusk.theme.colors).toEqual({
      ...BUILTIN_THEMES['calm-dark'].colors,
      '--color-bg': '#201a18',
      '--color-accent': '#c06a3a',
    });
    expect(paper.theme.colors).toEqual({ ...BUILTIN_THEMES['calm-light'].colors, '--color-bg': '#f7f3ea' });

    await list();
    const broken = warns.filter(warn => warn.includes(`${OWNER}/broken`));
    expect(broken).toHaveLength(1);
    expect(broken[0]).toContain('--color-bg 的值不是颜色');
  });

  it('插件停用后它的主题不再列出，重新启用后回来', async () => {
    const { app, list } = await setup();
    await app.plugins.disable(OWNER);
    expect((await list()).body.themes).toEqual([]);
    await app.plugins.enable(OWNER);
    await app.plugins.idle();
    expect((await list()).body.themes.map(entry => entry.id)).toEqual([`${OWNER}/dusk`, `${OWNER}/paper`]);
  });

  it('贡献点服务不在时没有插件主题，界面照常', async () => {
    const { list } = await setup({ hub: false });
    expect(await list()).toEqual({ status: 200, body: { themes: [] } });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { type PackageManagerService, packageManager } from '../../packages/api-package-manager/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { defineTexts } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, setHostLanguage } from '../fixtures/host-language.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 包管理的装卸与更新结果：message 与 conflicts 可以是文字对象，WebUI 的市场接口按全局层的语言渲染（en 拿英文，zh-CN
// 拿原文），原样的字符串照旧。包管理服务是替身，webui-server 与 plugin-i18n 是真的，全局语言写在宿主配置文档里。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-package-results-token-placeholder';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const t = defineTexts({
  ns: '@zz/package-results',
  language: 'zh-CN',
  source: { failed: '预检没有通过', conflict: '{name} 要求的 core 版本装不上' } as const,
  locales: { en: { failed: 'The dry run failed', conflict: 'The core version that {name} needs cannot be installed' } },
});

const fake: PackageManagerService = {
  install: async () => ({ ok: false, message: t('failed') }),
  uninstall: async () => ({ ok: false, message: t('failed') }),
  update: async () => ({
    ok: false,
    message: t('failed'),
    conflicts: [t('conflict', { name: '@zz/a' }), 'npm ERR! peer core@0.30'],
  }),
  serviceDependents: () => [],
  registry: async () => 'https://registry.example.invalid',
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const port = await freePort();
  const { app } = hostedApp(i18nSection(['en']), { logger: silent });
  apps.push(app);
  app.bind({ provide }).provide.use(packageManager, fake);
  const setLanguage = (language: string[]) => setHostLanguage(app, language);
  await app.plugin(i18nPlugin);
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/marketplace/${path}`, {
      method: 'POST',
      headers: { cookie: `aalis_webui_token=${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  return { post, setLanguage };
}

describe('包管理结果按全局层的语言', () => {
  it('更新的 message 与 conflicts、卸载的 message：en 拿英文，zh-CN 拿原文，原样的字符串照旧', async () => {
    const { post, setLanguage } = await setup();
    const update = { targets: [{ name: '@zz/a', version: '1.0.0' }] };
    expect(await post('update', update)).toEqual({
      ok: false,
      message: 'The dry run failed',
      conflicts: ['The core version that @zz/a needs cannot be installed', 'npm ERR! peer core@0.30'],
    });
    expect(await post('uninstall', { name: '@zz/a' })).toEqual({ ok: false, message: 'The dry run failed' });
    setLanguage(['zh-CN']);
    expect(await post('update', update)).toEqual({
      ok: false,
      message: '预检没有通过',
      conflicts: ['@zz/a 要求的 core 版本装不上', 'npm ERR! peer core@0.30'],
    });
  });
});

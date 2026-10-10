import { afterEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type App, provide, services } from '../../packages/core/src/index.js';
import type { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 配置 save() 可等待后，管理动作里「内存态变更」与「等落盘」的先后就有了语义：
// 内存里的变更必须在同一同步段完成，再等持久化，否则保存拒绝时变更永不执行。
// 本文件用拒绝落盘的 ConfigProvider 钉住「内存动作不依赖落盘成功」。
// ════════════════════════════════════════════════════════════

const running: Array<{ app: App; pages: PageHost }> = [];
afterEach(async () => {
  for (const { app, pages } of running.splice(0)) {
    await app.stop();
    pages.dispose();
  }
});

/** 一个落盘必拒的 App */
async function boot() {
  const { app } = hostedApp(
    {},
    {
      provider: {
        save: async () => {
          throw new Error('disk full');
        },
      },
    },
  );
  const pages = pageHost();
  running.push({ app, pages });
  const host = app.bind({ provide, services });
  host.provide.use(webuiServer, pages.service);
  host.provide.use(storage, {
    readFile: async () => {
      throw new Error('不存在');
    },
    writeFile: async () => undefined,
  } as never);

  await app.plugins.register(authorityPlugin, {});
  await app.plugins.idle();

  const manager = host.services.use.get(authority) as AuthorityManager | undefined;
  if (!manager) throw new Error('authority 服务未注册 —— 插件没起来');

  return { manager, pages };
}

describe('权限页的动作：内存态变更不依赖落盘成功', () => {
  it('免确认：保存拒绝时回 500，写明已在本次运行生效、没写进配置文件及原因；白名单的启用标记也已打上，页面照样重取', async () => {
    const { manager, pages } = await boot();
    const marked = vi.spyOn(manager, 'markPolicyEnabled');
    const before = pages.invalidations.length;
    expect(await pages.act('authority', 'waiveConfirm', { input: { pattern: 'tool:shell.exec' } })).toEqual({
      status: 500,
      body: { error: '已在本次运行中生效，但没写进配置文件：disk full' },
    });
    expect(marked).toHaveBeenCalledTimes(1);
    expect(pages.invalidations.slice(before), '改动已生效，表格要跟着重取').toEqual([
      { instance: '@aalis/plugin-authority', pageKey: 'authority' },
    ]);
  });
});

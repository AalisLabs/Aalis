import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessRequest, UserIdentity } from '../../packages/api-authority/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import { type App, provide, services } from '../../packages/core/src/index.js';
import type { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { hostedApp } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// 配置 save() 可等待后，管理动作里「内存态变更」与「等落盘」的先后就有了语义：
// 门槛抬高与旧授予撤销必须在同一同步段完成，再等持久化。若撤销排在 await 之后，
// 保存拒绝时撤销永不执行，保存进行中也有一段「门槛已抬、旧授予仍放行」的窗口。
// 本文件用拒绝落盘的 ConfigProvider 钉住「内存动作不依赖落盘成功」。
// ════════════════════════════════════════════════════════════

const req: AccessRequest = {
  name: 'shell.exec',
  type: 'tool',
  capability: 'tool:shell.exec',
  sessionId: 's1',
  platform: 'onebot',
  userId: 'alice',
  visibility: 'restricted',
} as AccessRequest;

const running: App[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
});

/** 一个落盘必拒的 App，外加 alice 在 s1 会话里的一条 session 级授予 */
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
  running.push(app);
  const host = app.bind({ provide, services });
  const registered = new Map<string, WebuiActionHandler>();
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction: (method: string, handler: WebuiActionHandler) => {
      registered.set(method, handler);
      return () => void registered.delete(method);
    },
  } as never);
  host.provide(storage, {
    readFile: async () => {
      throw new Error('不存在');
    },
    writeFile: async () => undefined,
  } as never);

  await app.plugins.register(authorityPlugin, {});
  await app.plugins.idle();

  const manager = host.services.get(authority) as AuthorityManager | undefined;
  if (!manager) throw new Error('authority 服务未注册 —— 插件没起来');
  manager.setUserLevel({ platform: 'onebot', userId: 'alice' }, 2);
  manager.setConfirmHandler('*', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }));
  expect(await manager.requestAccess(req), '前置：授予必须建起来').toBe(true);
  expect(manager.isPreApproved(req), '前置：救援闸此时靠授予放行').toBe(true);

  const call = async (method: string, args: Record<string, unknown> = {}, caller?: UserIdentity): Promise<unknown> => {
    const handler = registered.get(method);
    if (!handler) throw new Error(`页面动作 "${method}" 未登记 —— 管理面缺失`);
    return handler(args, caller);
  };
  return { manager, call };
}

describe('authority 管理动作：内存态变更不依赖落盘成功', () => {
  it('setAuthorityOverride：保存拒绝也已撤销该能力上的旧授予', async () => {
    const { manager, call } = await boot();
    await expect(call('setAuthorityOverride', { name: 'tool:shell.exec', level: 100 })).rejects.toThrow('disk full');
    expect(manager.isPreApproved(req), '门槛已抬，旧授予不得再放行').toBe(false);
  });

  it('setRestrictedPolicy：保存拒绝也已打上 policy 启用标记', async () => {
    const { manager, call } = await boot();
    const marked = vi.spyOn(manager, 'markPolicyEnabled');
    await expect(call('setRestrictedPolicy', { policy: { allow: ['tool:shell.exec'] } })).rejects.toThrow('disk full');
    expect(marked).toHaveBeenCalledTimes(1);
  });
});

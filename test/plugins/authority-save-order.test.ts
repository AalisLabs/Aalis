import type { AccessRequest } from '@aalis/api-authority';
import type { StorageService } from '@aalis/api-storage';
import type { ConfigManager, Context, Logger } from '@aalis/core';
import { describe, expect, it, vi } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { actions as declaredActions } from '../../packages/plugin-authority/src/index.js';

if (!declaredActions) throw new Error('plugin-authority 未导出 actions');
const actions = declaredActions;

// ════════════════════════════════════════════════════════════
// saveConfig 改为可等待后，管理动作里「内存态变更」与「等落盘」的先后就有了语义：
// 门槛抬高与旧授予撤销必须在同一同步段完成，再等持久化。若撤销排在 await 之后，
// 保存拒绝时撤销永不执行，保存进行中也有一段「门槛已抬、旧授予仍放行」的窗口。
// 本文件用拒绝的 saveConfig 钉住「内存动作不依赖落盘成功」。
// ════════════════════════════════════════════════════════════

function mkLogger(): Logger {
  const l = { child: () => l, debug() {}, info() {}, warn() {}, error() {} };
  return l as unknown as Logger;
}

const storage = { writeFile: async () => undefined } as unknown as StorageService;

const req: AccessRequest = {
  name: 'shell.exec',
  type: 'tool',
  capability: 'tool:shell.exec',
  sessionId: 's1',
  platform: 'onebot',
  userId: 'alice',
  visibility: 'restricted',
} as AccessRequest;

/** 一个 saveConfig 必拒绝的 ctx，外加 alice 在 s1 会话里的一条 session 级授予 */
async function makeCtx(): Promise<{ ctx: Context; manager: AuthorityManager }> {
  const data: Record<string, unknown> = {};
  const config = {
    get: (k: string) => data[k],
    set: (k: string, v: unknown) => {
      data[k] = v;
    },
  } as unknown as ConfigManager;
  const manager = new AuthorityManager(config, mkLogger(), storage);
  manager.setUserLevel({ platform: 'onebot', userId: 'alice' }, 2);
  manager.setConfirmHandler('*', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }));
  expect(await manager.requestAccess(req), '前置：授予必须建起来').toBe(true);
  expect(manager.isPreApproved(req), '前置：救援闸此时靠授予放行').toBe(true);

  const app = { saveConfig: () => Promise.reject(new Error('disk full')) };
  const ctx = {
    config,
    getService: (name: string) => (name === 'authority' ? manager : name === 'app' ? app : undefined),
    getAllServices: () => [],
  } as unknown as Context;
  return { ctx, manager };
}

describe('authority 管理动作：内存态变更不依赖落盘成功', () => {
  it('setAuthorityOverride：保存拒绝也已撤销该能力上的旧授予', async () => {
    const { ctx, manager } = await makeCtx();
    await expect(actions.setAuthorityOverride(ctx, { name: 'tool:shell.exec', level: 100 })).rejects.toThrow(
      'disk full',
    );
    expect(manager.isPreApproved(req), '门槛已抬，旧授予不得再放行').toBe(false);
  });

  it('setRestrictedPolicy：保存拒绝也已打上 policy 启用标记', async () => {
    const { ctx, manager } = await makeCtx();
    const marked = vi.spyOn(manager, 'markPolicyEnabled');
    await expect(actions.setRestrictedPolicy(ctx, { policy: { allow: ['tool:shell.exec'] } })).rejects.toThrow(
      'disk full',
    );
    expect(marked).toHaveBeenCalledTimes(1);
  });
});

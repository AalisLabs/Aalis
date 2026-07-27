import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { AuthorityService } from '../../packages/plugin-authority-api/src/index.js';
import * as commandsModule from '../../packages/plugin-commands/src/index.js';
import * as memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';

// ════════════════════════════════════════════════════════════
// /clear 的分场景授权
//
// /clear 清空**当前会话**的记忆，风险随会话归属而变：
//   - 私聊：会话归用户本人，清自己的记忆是自助行为——要等级就是剥夺；
//   - 群/频道：会话共享，一人清掉毁掉所有人的上下文——需等级 2。
// 静态能力声明表达不了「随会话归属而变」，故只声明 confirm（挡提示词注入触发的
// 误清），共享会话那一档在 action 里按 sessionType 判。
//
// 历史背景：这条保护原先挂在配置键 visibilityOverrides 上，该键在重构中失效后
// /clear 静默退回 public（任何 level-0 成员可清空群会话），无任何告警。
// ════════════════════════════════════════════════════════════

/** 假 authority：只实现本测用到的两个方法 */
function fakeAuthority(levels: Record<string, number>, owners: string[] = []): AuthorityService {
  return {
    isOwner: (platform: string, userId?: string) => owners.includes(`${platform}:${userId}`),
    listUsers: () =>
      Object.entries(levels).map(([k, level]) => {
        const [platform, userId] = k.split(':');
        return { platform, userId, level };
      }),
  } as unknown as AuthorityService;
}

async function setup(levels: Record<string, number>, owners: string[] = []) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(memoryInMemory);
  app.ctx.provide('authority', fakeAuthority(levels, owners));
  await app.ctx.useModule(commandsModule as never, {});
  await app.plugins.idle();
  return app;
}

/** 直接驱动已注册的 /clear action，绕开网关的解析层 */
async function runClear(
  app: App,
  session: { sessionId: string; platform: string; userId?: string; sessionType?: 'group' | 'private' | 'channel' },
): Promise<string> {
  const cmds = app.ctx.getService<{
    getAll(): Array<{ name: string; handler: (argv: unknown) => Promise<string> }>;
  }>('commands');
  const clear = cmds?.getAll().find(c => c.name === 'clear');
  if (!clear) throw new Error('/clear 未注册');
  return clear.handler({ session: { ...session, raw: '/clear' }, options: {}, args: [] });
}

describe('/clear 分场景授权', () => {
  it('私聊：level-0 用户可以清理自己的会话（自助权不被剥夺）', async () => {
    const app = await setup({ 'onebot:u1': 0 });
    const out = await runClear(app, {
      sessionId: 's-private',
      platform: 'onebot',
      userId: 'u1',
      sessionType: 'private',
    });
    expect(out, `私聊自助清理被拒了：${out}`).not.toContain('需要等级');
    await app.stop();
  });

  it('群聊：level-0 用户被拒，提示里说明私聊可自助', async () => {
    const app = await setup({ 'onebot:u1': 0 });
    const out = await runClear(app, {
      sessionId: 'onebot:g1',
      platform: 'onebot',
      userId: 'u1',
      sessionType: 'group',
    });
    expect(out).toContain('需要等级 2');
    expect(out).toContain('私聊');
    await app.stop();
  });

  it('群聊：level-2 用户放行', async () => {
    const app = await setup({ 'onebot:u2': 2 });
    const out = await runClear(app, {
      sessionId: 'onebot:g1',
      platform: 'onebot',
      userId: 'u2',
      sessionType: 'group',
    });
    expect(out).not.toContain('需要等级');
    await app.stop();
  });

  it('群聊：owner 放行（不看等级）', async () => {
    const app = await setup({}, ['onebot:boss']);
    const out = await runClear(app, {
      sessionId: 'onebot:g1',
      platform: 'onebot',
      userId: 'boss',
      sessionType: 'group',
    });
    expect(out).not.toContain('需要等级');
    await app.stop();
  });
});

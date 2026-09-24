import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthorityService, authority } from '../../packages/api-authority/src/index.js';
import { type ChatModelRequest, llm } from '../../packages/api-llm/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 指令自动提取的发言人门槛：按 authority 读发言人等级，owner 视为无穷大，
// 未登记的用户取默认等级。authority 不在场时不做 LLM 提取——没有门禁就不接受。
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:g1';
const INSTRUCTIONS_NS = 'aalis:instructions';

/** 桩 authority：owner-1 是 owner，admin-1 等级 2，low-1 等级 1，stranger-1 未登记 */
const stubAuthority = {
  isOwner: (platform: string, userId?: string) => platform === 'onebot' && userId === 'owner-1',
  listUsers: () => [
    { platform: 'onebot', userId: 'admin-1', isOwner: false, level: 2 },
    { platform: 'onebot', userId: 'low-1', isOwner: false, level: 1 },
  ],
} as unknown as AuthorityService;

const apps: App[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

async function setup(opts: { withAuthority: boolean; config?: Record<string, unknown> }) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, memory: memoryService });
  const requests: ChatModelRequest[] = [];
  const chat = vi.fn(async (req: ChatModelRequest) => {
    requests.push(req);
    return {
      content: JSON.stringify({
        add: [
          {
            text: '禁言不超过一天',
            category: '其他',
            severity: 'must',
            sourceUserKey: 'onebot:admin-1',
            sourceUserName: '管理员',
          },
        ],
        update: [],
        remove: [],
      }),
    };
  });
  host.provide(llm, { id: 'stub-model', capabilities: ['chat'], chat } as never);
  if (opts.withAuthority) host.provide(authority, stubAuthority);
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.idle();
  const memory = host.memory.current;
  if (!memory) throw new Error('memory 服务未就绪');
  await app.plugins.register(userProfile, {
    extractEveryNMessages: 0,
    instructionExtractEveryNMessages: 1,
    ...opts.config,
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userProfile.name)?.state !== 'active') throw new Error('user-profile 未激活');

  for (const userId of ['owner-1', 'admin-1', 'low-1', 'stranger-1']) {
    await memory.saveMessage(SESSION, {
      role: 'user',
      content: `来自 ${userId} 的发言`,
      metadata: { userId, platform: 'onebot' },
    });
  }
  await host.events.emit('inbound:message:archived', {
    sessionId: SESSION,
    incoming: { userId: 'admin-1', platform: 'onebot' },
  } as never);
  return { memory, chat, requests };
}

describe('plugin-user-profile: 指令自动提取按 authority 等级筛发言人', () => {
  it('authority 在场：owner 与等级达标的发言进入提取，等级不足与未登记的被跳过', async () => {
    const { memory, chat, requests } = await setup({ withAuthority: true });
    await vi.waitFor(async () => {
      expect(chat).toHaveBeenCalledTimes(1);
      expect(await memory.getMetadata(INSTRUCTIONS_NS, 'Aalis')).toBeTruthy();
    });

    const prompt = String(requests[0]?.messages.find(m => m.role === 'user')?.content ?? '');
    expect(prompt).toContain('来自 owner-1 的发言');
    expect(prompt).toContain('来自 admin-1 的发言');
    expect(prompt).not.toContain('来自 low-1 的发言');
    expect(prompt).not.toContain('来自 stranger-1 的发言');

    const doc = await memory.getMetadata(INSTRUCTIONS_NS, 'Aalis');
    expect(doc?.instructions).toEqual([expect.objectContaining({ text: '禁言不超过一天', sourceChannel: 'llm' })]);
  });

  it('authority 不在场：门槛放到 0 也不调用 LLM', async () => {
    const { memory, chat } = await setup({ withAuthority: false, config: { instructionMinAuthority: 0 } });
    // 同一事件处理里旁观计数先落库；等它落定再多给一拍，确认提取路径已走完
    await vi.waitFor(async () => {
      expect(await memory.getMetadata('user:profile', 'onebot:admin-1')).toBeTruthy();
    });
    await new Promise<void>(r => setTimeout(r, 50));
    expect(chat).not.toHaveBeenCalled();
    expect(await memory.getMetadata(INSTRUCTIONS_NS, 'Aalis')).toBeUndefined();
  });
});

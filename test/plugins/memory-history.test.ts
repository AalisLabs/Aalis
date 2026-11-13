import { describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type MemoryService, memory as memoryService } from '../../packages/api-memory/src/index.js';
import { type ToolCallRequest, tools } from '../../packages/api-tools/src/index.js';
import { App, logger, services } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { toolRequest } from '../fixtures/tool-call.js';

/** 这些会话在会话表里都是群（平台各给各的）：跨会话历史按取别的会话的规则逐条过，会话表里没有的取不到 */
const GROUPS: Record<string, string> = {
  current: 'onebot',
  other: 'onebot',
  's-a': 'onebot',
  's-b': 'webui',
  's-spam': 'onebot',
  's-quiet': 'onebot',
};

async function fileGroups(memory: MemoryService, groups: Record<string, string>) {
  await memory.commitMetadata(
    Object.entries(groups).map(([id, platform]) => ({
      op: 'put' as const,
      namespace: 'sessions',
      key: id,
      data: {
        id,
        children: [],
        status: 'waiting',
        createdAt: 0,
        updatedAt: 0,
        originPlatform: platform,
        originChat: { type: 'group', multiParty: true, targetId: id },
      },
    })),
  );
}

/**
 * 宿主侧装好 memory 后端与会话管理（smConfig 是会话管理的配置）。host 是根激活的绑定门面：`collect` 看到的是全局贡献，
 * 与 agent 组装器在生产里拿到的同一份视图。
 */
async function boot(smConfig: Record<string, unknown> = {}) {
  const app = new App({ logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ services, contributions, logger });
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const memory = host.services.use.get(memoryService);
  if (!memory) throw new Error('memory 服务未就绪');
  await fileGroups(memory, GROUPS);
  await app.plugin(sessionManagerPlugin, smConfig);
  await app.plugins.idle();
  if (app.plugins.getPlugin(sessionManagerPlugin.name)?.state !== 'active') throw new Error('会话管理未激活');
  return { app, host, memory };
}

async function saveAcross(
  memory: MemoryService,
  entries: Array<{ sessionId: string; platform?: string; content: string; ts: number; role?: 'user' | 'assistant' }>,
) {
  for (const e of entries) {
    await memory.saveMessage(e.sessionId, {
      role: e.role ?? 'user',
      content: e.content,
      timestamp: e.ts,
      metadata: e.platform ? { platform: e.platform } : undefined,
    });
  }
}

describe('plugin-memory-history', () => {
  it('范围全部：注入跨会话最近消息为独立 system block', async () => {
    const { app, host, memory } = await boot({ takeScope: 'all' });

    const baseTs = Date.now() - 10_000;
    await saveAcross(memory, [
      { sessionId: 's-a', platform: 'onebot', content: 'A1', ts: baseTs + 1 },
      { sessionId: 's-b', platform: 'webui', content: 'B1', ts: baseTs + 2 },
      { sessionId: 's-a', platform: 'onebot', content: 'A2', ts: baseTs + 3 },
    ]);

    await app.plugin(memoryHistory, {
      maxAgeMinutes: 0,
      excludeCurrentSession: false,
      headerText: '[TEST-HEADER]',
    });
    await app.plugins.idle();

    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      // 带一轮历史：没有它时「第一条非 system」与「最后一条 user」重合，
      // turn-context 与旧 context 锚位落点相同，位置断言失去判别力。
      { role: 'user', content: 'old-q' },
      { role: 'assistant', content: 'old-a' },
      { role: 'user', content: 'now' },
    ];
    await assemblePromptContributions(
      host,
      {
        messages,
        sessionId: 'current',
        platform: 'onebot',
      },
      [],
    );

    expect(messages.length).toBe(5);
    expect(messages[0].role).toBe('system');
    // 跨会话片段随其它会话的消息滚动、准每轮变（实测 46h 内注入 540 次），
    // 必须落在历史之后才不掐断前缀缓存（turn-context 锚位）
    expect(messages[1].content).toBe('old-q');
    expect(messages[2].content).toBe('old-a');
    expect(String(messages[3].metadata?.injector)).toMatch(/\/memory-history$/);
    expect(messages[3].content).toContain('[TEST-HEADER]');
    expect(messages[3].content).toContain('A1');
    expect(messages[3].content).toContain('B1');
    expect(messages[3].content).toContain('A2');
    expect(messages[4].role).toBe('user');
  });

  it('范围同平台（默认）：仅注入当前会话所在平台的消息', async () => {
    const { app, host, memory } = await boot();

    const baseTs = Date.now() - 5000;
    await saveAcross(memory, [
      { sessionId: 's-a', platform: 'onebot', content: 'ONE', ts: baseTs + 1 },
      { sessionId: 's-b', platform: 'webui', content: 'WEB', ts: baseTs + 2 },
    ]);

    await app.plugin(memoryHistory, {
      maxAgeMinutes: 0,
      excludeCurrentSession: false,
    });
    await app.plugins.idle();

    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await assemblePromptContributions(
      host,
      {
        messages,
        sessionId: 'current',
        platform: 'onebot',
      },
      [],
    );
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('ONE');
    expect(messages[0].content).not.toContain('WEB');
  });

  it('excludeCurrentSession: 默认排除当前会话', async () => {
    const { app, host, memory } = await boot();

    const baseTs = Date.now() - 1000;
    await saveAcross(memory, [
      { sessionId: 'current', platform: 'onebot', content: 'SELF', ts: baseTs + 1 },
      { sessionId: 'other', platform: 'onebot', content: 'OTHER', ts: baseTs + 2 },
    ]);

    await app.plugin(memoryHistory, { maxAgeMinutes: 0 });
    await app.plugins.idle();
    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await assemblePromptContributions(
      host,
      {
        messages,
        sessionId: 'current',
        platform: 'onebot',
      },
      [],
    );
    expect(messages.length).toBe(2);
    expect(messages[0].content).toContain('OTHER');
    expect(messages[0].content).not.toContain('SELF');
  });

  it('injectEnabled=false: 不注入', async () => {
    const { app, host, memory } = await boot();
    await saveAcross(memory, [{ sessionId: 's-a', platform: 'onebot', content: 'X', ts: Date.now() - 1000 }]);

    await app.plugin(memoryHistory, { injectEnabled: false });
    await app.plugins.idle();
    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await assemblePromptContributions(
      host,
      {
        messages,
        sessionId: 'current',
        platform: 'onebot',
      },
      [],
    );
    expect(messages.length).toBe(1);
  });

  it('maxAgeMinutes 过滤旧消息', async () => {
    const { app, host, memory } = await boot();
    const now = Date.now();
    await saveAcross(memory, [
      { sessionId: 's-a', platform: 'onebot', content: 'OLD', ts: now - 10 * 60_000 },
      { sessionId: 's-a', platform: 'onebot', content: 'NEW', ts: now - 60_000 },
    ]);

    await app.plugin(memoryHistory, {
      maxAgeMinutes: 5,
      excludeCurrentSession: false,
    });
    await app.plugins.idle();
    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await assemblePromptContributions(
      host,
      {
        messages,
        sessionId: 'current',
        platform: 'onebot',
      },
      [],
    );
    expect(messages[0].content).toContain('NEW');
    expect(messages[0].content).not.toContain('OLD');
  });

  it('重复触发 hook 不重复注入', async () => {
    const { app, host, memory } = await boot();
    await saveAcross(memory, [{ sessionId: 's-a', platform: 'onebot', content: 'X', ts: Date.now() - 1000 }]);

    await app.plugin(memoryHistory, {
      maxAgeMinutes: 0,
      excludeCurrentSession: false,
    });
    await app.plugins.idle();
    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await assemblePromptContributions(host, { messages, sessionId: 'current', platform: 'onebot' }, []);
    await assemblePromptContributions(host, { messages, sessionId: 'current', platform: 'onebot' }, []);
    const injected = messages.filter(m => String(m.metadata?.injector ?? '').endsWith('/memory-history'));
    expect(injected.length).toBe(1);
  });

  it('perSessionLimit 限制单会话刷屏占满 limit', async () => {
    const { app, host, memory } = await boot();

    const base = Date.now() - 1000;
    // s-spam 刷 20 条；s-quiet 只有 1 条但更新
    for (let i = 0; i < 20; i++) {
      await memory.saveMessage('s-spam', {
        role: 'user',
        content: `spam-${i}`,
        timestamp: base + i,
        metadata: { platform: 'onebot' },
      });
    }
    await memory.saveMessage('s-quiet', {
      role: 'user',
      content: 'quiet-only',
      timestamp: base + 100,
      metadata: { platform: 'onebot' },
    });

    await app.plugin(memoryHistory, {
      maxAgeMinutes: 0,
      excludeCurrentSession: false,
      limit: 10,
      perSessionLimit: 3,
    });
    await app.plugins.idle();

    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await assemblePromptContributions(host, { messages, sessionId: 'current', platform: 'onebot' }, []);
    const block = messages[0].content as string;
    // s-spam 只允许 3 条
    const spamCount = (block.match(/spam-/g) ?? []).length;
    expect(spamCount).toBe(3);
    expect(block).toContain('quiet-only');
  });
});

// ════════════════════════════════════════════════════════════
// recent_messages 权限档：它查的是别的会话（默认排除当前会话，能取哪些按取别的会话的规则），与 session_get_history
// 同属跨会话读取，同挂 risk: 'sensitive'——挡等级 0，等级 1 起照常可用、不弹确认。
// 走真链路：plugin-tools 执行 → plugin-authority 守卫 → 本插件 handler。
// ════════════════════════════════════════════════════════════

const GUARDED_GROUP = 'onebot:10000:group:20000';
const OTHER_GROUP = 'onebot:10000:group:20009';

async function bootGuarded() {
  // authority 裁决要读配置文档（owners 等），宿主经 host-config 提供
  const { app, store } = hostedApp({ plugins: { [memoryHistory.name]: { maxAgeMinutes: 0 } } });
  await registerHubs(app);
  const host = app.bind({ services, authority, tools });
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const memory = host.services.use.get(memoryService);
  if (!memory) throw new Error('memory 服务未就绪');
  await fileGroups(memory, { [GUARDED_GROUP]: 'onebot', [OTHER_GROUP]: 'onebot' });
  await app.plugin(toolsPlugin, {});
  await app.plugin(authorityPlugin, {});
  await registerFromDoc(app, store, sessionManagerPlugin);
  await registerFromDoc(app, store, memoryHistory);
  await app.plugins.idle();
  // 守卫是 authority 激活时挂上去的：任一插件停在 pending，下面的拒绝断言会退化成恒真或恒假
  for (const p of [memoryInMemory, toolsPlugin, authorityPlugin, sessionManagerPlugin, memoryHistory]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  const toolSvc = host.tools.present ? host.tools.use : undefined;
  const authoritySvc = host.authority.present ? host.authority.use : undefined;
  if (!toolSvc || !authoritySvc) throw new Error('服务未就绪');
  await memory.saveMessage(OTHER_GROUP, {
    role: 'user',
    content: 'OTHER-GROUP-ONLY',
    timestamp: Date.now() - 1000,
    metadata: { platform: 'onebot' },
  });
  return { app, toolSvc, authoritySvc };
}

/** 群会话里开了 session-history 组：被拒只能来自权限档，不是分组闸 */
function groupCall(userId: string): ToolCallRequest {
  return toolRequest({ sessionId: GUARDED_GROUP, platform: 'onebot', userId, enabledGroups: ['session-history'] });
}

describe('recent_messages 权限档（sensitive）', () => {
  it('等级 0 的群成员调用被拒，拿不到别的会话的内容', async () => {
    const { app, toolSvc } = await bootGuarded();
    const out = await toolSvc.execute('recent_messages', {}, groupCall('20001'));
    await app.stop();
    expect(out.content).toContain('权限不足');
    expect(out.content).not.toContain('OTHER-GROUP-ONLY');
  });

  it('等级 1 的群成员照常调用，且不需确认（本实例没有审批服务，需要确认就会被拒）', async () => {
    const { app, toolSvc, authoritySvc } = await bootGuarded();
    authoritySvc.setUserLevel({ platform: 'onebot', userId: '20002' }, 1);
    const out = await toolSvc.execute('recent_messages', {}, groupCall('20002'));
    await app.stop();
    expect(out.content).toContain('OTHER-GROUP-ONLY');
  });
});

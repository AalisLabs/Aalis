import { afterEach, describe, expect, it } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import type {} from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { BACKGROUND_TASK_NOTICE, tools } from '../../packages/api-tools/src/index.js';
import { type App, events, provide, services } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import schedulerPlugin, { scheduler } from '../../packages/plugin-scheduler/src/index.js';
import subtaskPlugin from '../../packages/plugin-subtask/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { runDag } from '../../packages/plugin-workflow/src/engine.js';
import { type IncomingMessage, selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { silentLogger } from '../fixtures/authority.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-storage.js';

// ════════════════════════════════════════════════════════════
// 只有人亲手写的文字才执行指令：真人入站（不带 source）照常解析；带 source 的注入只有声明了 ownerApproved 的
// （定时任务：建任务时 owner 过目过原文）照常解析，其余当普通消息往下走，判据不看 source 的名字。
// 真实的网关、指令、权限、工具、子任务与定时任务插件，编排走真实的 DAG 引擎；指令是两条探针：halt 与 /shutdown 同为
// restricted（续做等带 owner 授权身份的注入以 owner 身份到达），probe 不设门槛（不带 owner 身份的注入）。往下走的消息在 dispatch 相位记下。
// ════════════════════════════════════════════════════════════

const OWNER = { platform: 'webui', userId: 'console' };
const PARENT = 'webui:parent';
const CHILD = 'webui:parent::child';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(schedulerConfig: Record<string, unknown> = {}) {
  const { app } = hostedApp();
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ events, hooks, services, commands, provide, tools });
  host.provide.use(storage, memoryStorage().service as never);
  host.provide.use(sessionManager, {
    getSession: (id: string) => (id === CHILD ? { id, parentId: PARENT, status: 'active' } : undefined),
    listSessions: () => [],
    recordInbound: async () => {},
    createChildSession: async () => ({ id: CHILD }),
    updateSession: async () => {},
  } as never);
  // 会话设置的替身：父会话没有各层的值，子会话不写下什么
  host.provide.use(sessionSettings, {
    register: () => () => {},
    chain: () => ({ parts: [] }),
    childMetadata: () => ({}),
  } as never);
  for (const plugin of [gatewayPlugin, commandsPlugin, authorityPlugin, toolsPlugin, cronEnginePlugin, subtaskPlugin]) {
    await app.plugin(plugin);
  }
  await app.plugin(schedulerPlugin, schedulerConfig);
  await app.plugins.idle();
  for (const p of [gatewayPlugin, commandsPlugin, authorityPlugin, toolsPlugin, subtaskPlugin, schedulerPlugin]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  const ran: string[] = [];
  host.commands.use.command('halt', '探针', { visibility: 'restricted' }).action(async () => {
    ran.push('halt');
    return 'halted';
  });
  host.commands.use.command('probe', '探针').action(async () => {
    ran.push('probe');
    return 'probed';
  });
  const passed: IncomingMessage[] = [];
  host.hooks.use.middleware('inbound:dispatch', async data => {
    passed.push(data.message);
  });
  /** 入站相位链跑完 count 条（指令执行了或往下走了都算） */
  const settled = (count = 1) =>
    new Promise<void>(resolve => {
      const off = host.events.use.on('gateway:phase:done', ({ phase, reachedEnd }) => {
        if (phase !== 'inbound:dispatch' && (phase !== 'inbound:command' || reachedEnd)) return;
        if (--count > 0) return;
        off();
        resolve();
      });
    });
  const say = async (msg: IncomingMessage) => {
    const done = settled();
    await host.events.use.emit('inbound:message', msg);
    await done;
  };
  return { app, host, say, ran, passed, settled };
}

describe('真人入站与经 owner 审批的注入：照常执行', () => {
  it('owner 在 WebUI 亲手输入', async () => {
    const s = await setup();
    await s.say({ content: '/halt', sessionId: 'webui:s1', ...OWNER });
    expect(s.ran).toEqual(['halt']);
    expect(s.passed).toEqual([]);
  });

  it('定时任务（配置里的任务，创建者是 owner）', async () => {
    const s = await setup({ jobs: [{ name: 'j', interval: 3600, content: '/halt' }] });
    const done = s.settled();
    await s.host.services.use.get(scheduler)!.triggerJob('j');
    await done;
    expect(s.ran).toEqual(['halt']);
    expect(s.passed).toEqual([]);
  });
});

describe('其余带 source 的注入：不过指令解析，当普通消息交给她', () => {
  const ownerCall = { sessionId: PARENT, platform: OWNER.platform, userId: OWNER.userId };

  it('子任务的任务正文', async () => {
    const s = await setup();
    const done = s.settled();
    await s.host.tools.use.execute('create_subtask', { task: '/halt' }, ownerCall);
    await done;
    expect(s.ran).toEqual([]);
    expect(s.passed.map(m => [m.sessionId, m.source, m.content])).toEqual([[CHILD, 'subtask', '/halt']]);
  });

  it('子任务的追加消息', async () => {
    const s = await setup();
    const done = s.settled();
    await s.host.tools.use.execute('send_to_subtask', { subtask_id: CHILD, message: '/halt' }, ownerCall);
    await done;
    expect(s.ran).toEqual([]);
    expect(s.passed.map(m => [m.sessionId, m.source, m.content])).toEqual([[CHILD, 'subtask', '/halt']]);
  });

  it('编排的发消息节点与 agent 节点（owner 调起）', async () => {
    const s = await setup();
    const done = s.settled(2);
    await runDag({
      tools: s.host.tools,
      events: s.host.events.use,
      hooks: s.host.hooks.use,
      logger: silentLogger(),
      def: {
        id: 'wf',
        trigger: { type: 'manual' },
        nodes: [
          { id: 'send', type: 'send-message', sessionId: 'webui:s1', platform: 'webui', content: '/halt' },
          { id: 'ask', type: 'agent', instruction: '/halt', timeoutSeconds: 0.05 },
        ],
      },
      runId: 'r1',
      vars: {},
      toolCallContext: { sessionId: 'webui:s1', actor: OWNER },
      signal: new AbortController().signal,
    });
    await done;
    expect(s.ran).toEqual([]);
    expect(s.passed.map(m => [m.source, m.content]).sort()).toEqual([
      ['workflow:wf', '/halt'],
      ['workflow:wf:ask', '/halt'],
    ]);
  });

  // 宿主通知与空闲触发的正文本身不以指令前缀开头（空闲触发的提示词来自配置），这里按各注入方的消息形状放进一条指令，
  // 钉住判据本身；末一条是第三方注入方冒用定时任务的来源名、不声明
  const shaped: Array<[string, IncomingMessage]> = [
    [
      '后台任务的结束通知（延续 owner 的调用）',
      {
        content: '/halt',
        sessionId: 'webui:s1',
        platform: 'webui',
        source: 'bg:bg-1',
        fromTurn: { ...OWNER, participants: [OWNER] },
        hostNotice: { kind: BACKGROUND_TASK_NOTICE, id: 'bg-1' },
      },
    ],
    [
      '白纸的完成通知',
      {
        content: '/probe',
        sessionId: 'onebot:10000:group:20001',
        platform: 'onebot',
        source: 'paper:p1:t1',
        actor: selfInitiatedActor('onebot'),
        hostNotice: { kind: 'paper-task', id: 'n1' },
      },
    ],
    [
      '作品通知',
      {
        content: '/probe',
        sessionId: 'onebot:10000:group:20001',
        platform: 'onebot',
        source: 'publish:w1',
        actor: selfInitiatedActor('onebot'),
        hostNotice: { kind: 'publish-review', id: 'w1', reportOnly: true },
      },
    ],
    [
      '空闲触发',
      { content: '/probe', sessionId: 'onebot:10000:group:20001', platform: 'onebot', source: 'idle-trigger' },
    ],
    [
      '伪造：source 写成 scheduler、带 owner 的 actor、不声明',
      { content: '/halt', sessionId: 'internal', platform: 'internal', source: 'scheduler', actor: OWNER },
    ],
  ];
  it.each(shaped)('%s', async (_label, message) => {
    const s = await setup();
    await s.say(message);
    expect(s.ran).toEqual([]);
    expect(s.passed).toEqual([message]);
  });
});

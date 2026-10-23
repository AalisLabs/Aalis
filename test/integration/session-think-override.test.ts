import { describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import { type ChatModelRequest, type LLMModel, llm, type ThinkingLevels } from '../../packages/api-llm/src/index.js';
import { sessionManager as sessionManagerService } from '../../packages/api-session-manager/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { App, definePlugin, lifecycle, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 会话的深度思考档位端到端：/session.set 把模型与档位写进本会话层 → agent 每一轮按会话读，当前模型有这一档才把它装进请求，
// 没设、模型没有这一档或不能调时请求不带 think，由模型服务按它的默认档 → /session.reset 恢复继承后回落。写入时不按模型核
// 档位（下一轮由 agent 按模型判）。/session 里模型没设时写此刻实际在用的模型（agent 交的 actual）。
// ════════════════════════════════════════════════════════════

const PROVIDER = 'zz-llm';
const OWNER = { platform: 'test', userId: 'u1' };
const DEEP: ThinkingLevels = {
  levels: [
    { id: 'off', label: '关' },
    { id: 'high', label: '高' },
    { id: 'max', label: '最高' },
  ],
  default: 'high',
};
const SWITCH: ThinkingLevels = {
  levels: [
    { id: 'off', label: '关' },
    { id: 'on', label: '开' },
  ],
  default: 'on',
};

type Sent = { model: string; request: ChatModelRequest };

/** 三个对话模型：deep 有关、高、最高三档，switch 有关、开两档，plain 不能调；每次请求记进 sent */
function models(sent: Sent[]) {
  return definePlugin({
    name: PROVIDER,
    provides: [llm],
    uses: { provide, lifecycle },
    apply(caps) {
      for (const [id, thinking] of [
        ['deep', DEEP],
        ['switch', SWITCH],
        ['plain', undefined],
      ] as const) {
        const handle: LLMModel = {
          id,
          providerId: caps.lifecycle.use.id,
          contextLength: 8192,
          maxOutputTokens: 1024,
          capabilities: ['chat', 'streaming'],
          ...(thinking ? { thinking } : {}),
          async chat(request) {
            sent.push({ model: id, request });
            return { content: 'ok' };
          },
          async *chatStream(request) {
            sent.push({ model: id, request });
            yield { contentDelta: `ok ${sent.length}` };
            yield { done: true };
          },
        };
        caps.provide.use(llm, handle, { entryId: `${caps.lifecycle.use.id}/${id}` });
      }
    },
  });
}

async function loadStack(sent: Sent[]) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  // 指令判门槛要权限服务：u1 是 owner，项与层的门槛都过
  app.bind({ provide }).provide.use(authority, {
    isOwner: (platform: string, userId?: string) => platform === OWNER.platform && userId === OWNER.userId,
    authorize: () => null,
    meetsLevel: () => true,
  } as never);
  await app.plugin(models(sent));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  // gateway 是 plugin-commands 的 required 依赖：生产里指令插件只在网关在场时才激活
  await app.plugin(gatewayPlugin, {});
  await app.plugin(commandsPlugin, {});
  await app.plugin(sessionManagerPlugin);
  await app.plugin(sessionSettingsPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test bot', memoryTokenBudget: 1024 });
  await app.plugins.idle();
  // 装载过激活闸：依赖没凑齐的插件停在 pending 而不报错，会让「整条链根本没跑」伪装成绿
  for (const id of [commandsPlugin.name, sessionManagerPlugin.name, sessionSettingsPlugin.name, agentPlugin.name]) {
    const state = app.plugins.getPlugin(id)?.state;
    if (state !== 'active') throw new Error(`插件 ${id} 未激活（state=${state}）`);
  }
  const host = app.bind({
    agent: agentService,
    sessionManager: sessionManagerService,
    sessionSettings,
    commands: commandsService,
  });
  const commands = host.commands.use;
  // /session 系列声明了 risk:'sensitive'，没有守卫时会被拒：放行守卫代替 plugin-authority 的执行守卫（本文件测的不是鉴权）
  commands.setExecutionGuard(async () => ({ ok: true }));
  /** 在会话里敲一条指令，回执的文字 */
  const run = async (sessionId: string, name: string, args: string[]) =>
    String(await commands.execute(name, { sessionId, ...OWNER, args, raw: [name, ...args].join(' ') }));
  return { app, agent: host.agent.use, sm: host.sessionManager.use, run };
}

const incoming = (sessionId: string): IncomingMessage => ({
  content: 'hi',
  sessionId,
  ...OWNER,
  sessionType: 'private',
});

describe('会话的深度思考档位端到端', () => {
  it('当前模型有这一档才带上；换到没有这一档的模型、不能调的模型时不带；恢复继承后回落', async () => {
    const sent: Sent[] = [];
    const { app, agent, sm, run } = await loadStack(sent);
    const turn = async (sessionId: string) => {
      await agent.handleMessage(incoming(sessionId));
      return sent.at(-1) as Sent;
    };
    await sm.ensureSession('s1');
    await sm.ensureSession('s2');

    await run('s1', 'session.set', ['llm', `${PROVIDER}/deep`]);
    const baseline = await turn('s1');
    expect(baseline.model).toBe('deep');
    expect('think' in baseline.request, '没设置时不带 think').toBe(false);

    expect(await run('s1', 'session.set', ['think', 'max'])).toContain('max');
    expect((await turn('s1')).request.think).toBe('max');
    expect('think' in (await turn('s2')).request, '别的会话不受影响').toBe(false);

    await run('s1', 'session.set', ['llm', `${PROVIDER}/switch`]);
    const fallback = await turn('s1');
    expect(fallback.model).toBe('switch');
    expect('think' in fallback.request, '当前模型没有这一档时按它的默认档').toBe(false);

    await run('s1', 'session.set', ['llm', `${PROVIDER}/plain`]);
    expect('think' in (await turn('s1')).request, '不能调的模型不带').toBe(false);

    await run('s1', 'session.set', ['llm', `${PROVIDER}/deep`]);
    expect((await turn('s1')).request.think).toBe('max');
    await run('s1', 'session.reset', ['think']);
    expect('think' in (await turn('s1')).request, '恢复继承后回落到不带').toBe(false);

    await app.stop();
  });

  it('/session 里模型没设时写此刻实际在用的模型；会话设了模型就写设的那一个', async () => {
    const sent: Sent[] = [];
    const { app, sm, run } = await loadStack(sent);
    await sm.ensureSession('s4');
    expect(await run('s4', 'session', []), '没有偏好：服务解析到登记在先的 deep').toContain(
      `跟随服务偏好（此刻：${PROVIDER}/deep）`,
    );
    await run('s4', 'session.set', ['llm', `${PROVIDER}/switch`]);
    const view = await run('s4', 'session', []);
    expect(view).toContain(`${PROVIDER}/switch`);
    expect(view).not.toContain('此刻');

    await app.stop();
  });
});

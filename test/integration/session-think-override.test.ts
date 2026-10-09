import { describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import { type ChatModelRequest, type LLMModel, llm, type ThinkingLevels } from '../../packages/api-llm/src/index.js';
import { sessionManager as sessionManagerService } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, lifecycle, provide, services } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { PERSONA, settingsPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 会话的深度思考档位（/session.set -t <档位>）端到端：指令按当前模型声明的档位校验后写入会话设置 → agent 解析会话设置，
// 当前模型有这一档才把它装进请求，没设置、模型没有这一档或不能调时请求不带 think，由模型服务按它的默认档 →
// /session 写明当前模型的档位与这一档用不上的原因 → /session.reset 回落。
// ════════════════════════════════════════════════════════════

const PROVIDER = 'zz-llm';
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
          providerId: caps.lifecycle.id,
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
            yield { contentDelta: 'ok' };
            yield { done: true };
          },
        };
        caps.provide(llm, handle, { entryId: `${caps.lifecycle.id}/${id}` });
      }
    },
  });
}

async function loadStack(sent: Sent[]) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  await app.plugin(models(sent));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  // gateway 是 plugin-commands 的 required 依赖：生产里指令插件只在网关在场时才激活
  await app.plugin(gatewayPlugin, {});
  await app.plugin(commandsPlugin, {});
  await app.plugin(sessionManagerPlugin);
  // 人设这一项由人设插件登记，这里不装人设插件，由测试插件代登
  await app.plugin(settingsPlugin('persona-settings', [PERSONA]));
  await app.plugin(agentPlugin, {
    systemPrompt: 'test bot',
    memoryTokenBudget: 1024,
    preferredModel: '',
  });
  await app.plugins.idle();
  // 装载过激活闸：依赖没凑齐的插件停在 pending 而不报错，会让「整条链根本没跑」伪装成绿
  for (const id of [commandsPlugin.name, sessionManagerPlugin.name, agentPlugin.name]) {
    const state = app.plugins.getPlugin(id)?.state;
    if (state !== 'active') throw new Error(`插件 ${id} 未激活（state=${state}）`);
  }
  const host = app.bind({ agent: agentService, sessionManager: sessionManagerService, commands: commandsService });
  const commands = host.commands.require();
  // /session.* 声明了 risk:'sensitive'，没有守卫时会被拒：放行守卫代替 plugin-authority（本文件测的不是鉴权）
  commands.setExecutionGuard(async () => null);
  return { app, agent: host.agent.require(), sm: host.sessionManager.require(), commands };
}

const incoming = (sessionId: string): IncomingMessage => ({
  content: 'hi',
  sessionId,
  platform: 'test',
  userId: 'u1',
  sessionType: 'private',
});

const cmdInput = (sessionId: string, args: string[]) => ({
  sessionId,
  platform: 'test',
  userId: 'u1',
  args,
  raw: args.join(' '),
});

describe('会话的深度思考档位端到端', () => {
  it('当前模型有这一档才带上；换到没有这一档的模型、不能调的模型时不带，/session 写明原因；reset 回落', async () => {
    const sent: Sent[] = [];
    const { app, agent, commands } = await loadStack(sent);
    const turn = async (sessionId: string) => {
      await agent.handleMessage(incoming(sessionId));
      return sent.at(-1) as Sent;
    };

    await commands.execute('session.set', cmdInput('s1', ['-m', `${PROVIDER}/deep`]));
    const baseline = await turn('s1');
    expect(baseline.model).toBe('deep');
    expect('think' in baseline.request, '没设置时不带 think').toBe(false);

    expect(await commands.execute('session.set', cmdInput('s1', ['-t', 'max']))).toContain('深度思考: max');
    expect((await turn('s1')).request.think).toBe('max');
    expect('think' in (await turn('s2')).request, '别的会话不受影响').toBe(false);

    await commands.execute('session.set', cmdInput('s1', ['-m', `${PROVIDER}/switch`]));
    const fallback = await turn('s1');
    expect(fallback.model).toBe('switch');
    expect('think' in fallback.request, '当前模型没有这一档时按它的默认档').toBe(false);
    const view = String(await commands.execute('session', cmdInput('s1', [])));
    expect(view).toContain('深度思考: max');
    expect(view).toContain('当前模型没有这一档，按默认');
    expect(view).toContain('off（关）、on（开），默认 on');

    await commands.execute('session.set', cmdInput('s1', ['-m', `${PROVIDER}/plain`]));
    expect('think' in (await turn('s1')).request, '不能调的模型不带').toBe(false);
    expect(String(await commands.execute('session', cmdInput('s1', [])))).toContain('当前模型不能调');

    const reset = await commands.execute('session.reset', cmdInput('s1', ['-t']));
    expect(reset).toContain('深度思考: (默认)');
    await commands.execute('session.set', cmdInput('s1', ['-m', `${PROVIDER}/deep`]));
    expect('think' in (await turn('s1')).request, 'reset 后回落到不带').toBe(false);

    await app.stop();
  });

  it('-t 按当前模型（同时给了 -m 时按新模型）的档位校验：没有这一档、模型不能调都拒绝且不写；reset -t 只清深度思考', async () => {
    const sent: Sent[] = [];
    const { app, sm, commands } = await loadStack(sent);

    await sm.ensureSession('s3', { config: { persona: 'keep-me', llm: { provider: PROVIDER, model: 'switch' } } });
    expect(await commands.execute('session.set', cmdInput('s3', []))).toBe('至少给一项。敲 /session.set -h 看用法');
    const unknown = await commands.execute('session.set', cmdInput('s3', ['-t', 'max']));
    expect(unknown).toContain('当前模型没有档位「max」，可选：off（关）、on（开）');
    expect(sm.resolveConfig('s3', 'test').think).toBeUndefined();

    const plain = await commands.execute('session.set', cmdInput('s3', ['-m', `${PROVIDER}/plain`, '-t', 'on']));
    expect(plain).toBe('当前模型不能调深度思考');
    expect(sm.resolveConfig('s3', 'test').llm).toEqual({ provider: PROVIDER, model: 'switch' });

    await commands.execute('session.set', cmdInput('s3', ['-m', `${PROVIDER}/deep`, '-t', 'max']));
    expect(sm.resolveConfig('s3', 'test').think).toBe('max');

    await commands.execute('session.reset', cmdInput('s3', ['-t']));
    const eff = sm.resolveConfig('s3', 'test');
    expect(eff.think, 'reset -t 清深度思考').toBeUndefined();
    expect(eff.persona, 'reset -t 不动人设').toBe('keep-me');
    expect(eff.llm, 'reset -t 不动模型').toEqual({ provider: PROVIDER, model: 'deep' });

    await app.stop();
  });
});

describe('/session 写明这一轮会用的模型', () => {
  it('哪一层都没设、偏好也没有时写实际用的模型；偏好指向的模型不在时同样写出实际用的；会话设了模型就不另写', async () => {
    const sent: Sent[] = [];
    const { app, commands } = await loadStack(sent);
    const view = async () => String(await commands.execute('session', cmdInput('s4', [])));

    const unset = await view();
    expect(unset).toContain('模型: (默认)');
    expect(unset, '没有偏好：服务解析到登记在先的 deep').toContain(`这一轮会用: ${PROVIDER}/deep`);

    // 全局默认层的「模型」即服务偏好；这个栈没有宿主配置文档，直接经服务门面设偏好
    expect(app.bind({ services }).services.prefer(llm, `${PROVIDER}/gone`)).toBe(true);
    expect(await view(), '偏好指向的模型不在：回落到 deep').toContain(`这一轮会用: ${PROVIDER}/deep`);

    await commands.execute('session.set', cmdInput('s4', ['-m', `${PROVIDER}/switch`]));
    expect(await view()).not.toContain('这一轮会用');

    await app.stop();
  });
});

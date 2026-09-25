import { describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { sessionManager as sessionManagerService } from '../../packages/api-session-manager/src/index.js';
import { App } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 会话级 thinking 覆盖（/session.set -t on|off）端到端：
//   指令写入 session config → resolveConfig 解析链 → agent 把 think 装进
//   ChatModelRequest（ollama/deepseek 原生认请求级 think）→ /session.reset 回落。
// 契约：未设置时请求**不带** think 字段（provider 按各自全局配置决策）。
// ════════════════════════════════════════════════════════════

async function loadStack(recorder: ChatModelRequest[]) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  await app.plugin(createMockLLMPlugin({ responses: [{ content: 'ok' }], recorder }));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  // gateway 是 plugin-commands 的 required 依赖：生产里指令插件只在网关在场时才激活
  await app.plugin(gatewayPlugin, {});
  await app.plugin(commandsPlugin, {});
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(agentPlugin, {
    systemPrompt: 'test bot',
    historyLimit: 10,
    memoryTokenBudget: 1024,
    maxToolIterations: 3,
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

describe('会话 thinking 覆盖端到端', () => {
  it('未设置 → 请求不带 think；set -t off → 请求 think:false；reset → 回落不带', async () => {
    const recorder: ChatModelRequest[] = [];
    const { app, agent, commands } = await loadStack(recorder);

    // 1. 基线：无覆盖，请求不带 think 字段
    await agent.handleMessage(incoming('s1'));
    expect(recorder).toHaveLength(1);
    expect('think' in recorder[0], '未设置时不该带 think 字段').toBe(false);

    // 2. /session.set -t off → 覆盖生效
    const setOut = await commands.execute('session.set', cmdInput('s1', ['-t', 'off']));
    expect(setOut).toContain('thinking: off');
    await agent.handleMessage(incoming('s1'));
    expect(recorder).toHaveLength(2);
    expect(recorder[1].think, '覆盖 off 应以 think:false 落进请求').toBe(false);

    // 3. 另一个会话不受影响
    await agent.handleMessage(incoming('s2'));
    expect('think' in recorder[2]).toBe(false);

    // 4. /session.reset → 回落全局（不带 think）
    const resetOut = await commands.execute('session.reset', cmdInput('s1', []));
    expect(resetOut).toContain('thinking: (默认)');
    await agent.handleMessage(incoming('s1'));
    expect('think' in recorder[3], 'reset 后应回落到不带 think').toBe(false);

    await app.stop();
  });

  it('set -t on 与 -t 非法值；reset -t 只清 thinking 不动人设', async () => {
    const recorder: ChatModelRequest[] = [];
    const { app, sm, commands } = await loadStack(recorder);

    // 非法值如实拒绝
    const bad = await commands.execute('session.set', cmdInput('s3', ['-t', 'maybe']));
    expect(bad).toContain('只能是 on 或 off');

    // -t on 与 -p 同时设置；reset -t 只清 thinking
    await sm.ensureSession('s3', { config: { persona: 'keep-me' } });
    const out = await commands.execute('session.set', cmdInput('s3', ['-t', 'on']));
    expect(out).toContain('thinking: on');
    expect(sm.resolveConfig('s3', 'test').think).toBe(true);

    await commands.execute('session.reset', cmdInput('s3', ['-t']));
    const eff = sm.resolveConfig('s3', 'test');
    expect(eff.think, 'reset -t 应清 thinking').toBeUndefined();
    expect(eff.persona, 'reset -t 不该动人设').toBe('keep-me');

    await app.stop();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { App, type BoundOf, provide, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 会话环境按出生平台：WebUI 往 IM 房间插话时，这一轮的回复发进房间，会话事实（平台、自身账号、会话类型与群号）
// 按房间的出生平台取；说话人事实（发送者 ID、昵称、群身份）照旧取自消息；入口与出生平台不同时注明消息经哪个入口发来。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

const hostUses = { hooks, services, provide };

describe('persona 会话环境按出生平台', () => {
  let app: App;
  let host: BoundOf<typeof hostUses>;
  let svc: PersonaService;

  const boot = async (): Promise<void> => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    host = app.bind(hostUses);
    host.provide(platform, {
      adapterName: 'OneBot',
      platform: 'onebot',
      getConnections: () => [],
      sendMessage: async () => {},
      getSelfIdentity: () => ({ platform: 'onebot', selfId: '10000', nickname: 'Aalis' }),
    } as never);
    await app.plugin(personaPlugin, { timeInjection: false });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(personaPlugin.name)?.state, 'persona 未激活').toBe('active');
    const found = host.services.get(persona);
    if (!found) throw new Error('persona 服务未就绪');
    svc = found;
  };

  /** 经 agent:input:before 装上会话身份，在钩子链内取易变上下文 */
  const volatileFor = async (message: IncomingMessage): Promise<string> => {
    let prompt = '';
    await host.hooks.run('agent:input:before', { message, metadata: {} }, async () => {
      prompt = svc.getVolatilePrompt?.() ?? '';
    });
    return prompt;
  };

  afterEach(async () => {
    await app.stop();
  });

  it('WebUI 入口往群房间插话：会话事实按 onebot，发送者照旧取自消息，注明经 webui 发来', async () => {
    await boot();
    const prompt = await volatileFor({ content: '<占位>', sessionId: GROUP, platform: 'webui', userId: 'console' });
    expect(prompt).toContain('当前平台：onebot');
    expect(prompt).not.toContain('当前平台：webui');
    expect(prompt).toContain('你在当前平台的账号：Aalis（10000）');
    expect(prompt).toContain('会话类型：群聊');
    expect(prompt).toContain('群号：20001');
    expect(prompt).toContain('当前消息经 webui 发来');
    expect(prompt).toContain('当前消息发送者 ID：console');
  });

  it('WebUI 入口往私聊房间插话：会话类型为私聊', async () => {
    await boot();
    const prompt = await volatileFor({ content: '<占位>', sessionId: PRIVATE, platform: 'webui', userId: 'console' });
    expect(prompt).toContain('当前平台：onebot');
    expect(prompt).toContain('会话类型：私聊');
    expect(prompt).toContain('当前消息经 webui 发来');
  });

  it('onebot 入口的群消息：与原来一致，不注明入口', async () => {
    await boot();
    const prompt = await volatileFor({
      content: '<占位>',
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      userId: '30001',
      nickname: '群友',
    });
    expect(prompt).toContain('当前平台：onebot');
    expect(prompt).toContain('你在当前平台的账号：Aalis（10000）');
    expect(prompt).toContain('会话类型：群聊');
    expect(prompt).toContain('群号：20001');
    expect(prompt).toContain('当前消息发送者昵称：群友');
    expect(prompt).not.toContain('当前消息经');
  });

  it('owner 面会话（没有出生平台）照旧按入口平台，不注明入口', async () => {
    await boot();
    const prompt = await volatileFor({ content: '<占位>', sessionId: 'session-abcd1234', platform: 'webui' });
    expect(prompt).toContain('当前平台：webui');
    expect(prompt).not.toContain('会话类型');
    expect(prompt).not.toContain('当前消息经');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, type BoundOf, provide, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 合成回合（scheduler / workflow / idle）不经适配器，消息上没有 sessionType，
// persona 的群聊段（会话类型、群号、身份判定规则）曾因此整段缺席：LLM 不知道自己在群里。
// 现取会话记下的聊天窗口（房间建档时记下的类型名与目标），只用于提示词、不回写消息
// （这时入站相位已跑完，回写只会让它随归档写进消息元数据）。子任务的出生平台取根会话的，聊天窗口不取：
// 子任务不是群里的对话。真 agent:input:before 钩子驱动（生产路径），在钩子链内读易变上下文。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

const hostUses = { hooks, services, provide, sessionManager };

describe('persona 合成回合的会话类型取会话记下的聊天窗口', () => {
  let app: App;
  let host: BoundOf<typeof hostUses>;
  let svc: PersonaService;

  const boot = async (): Promise<void> => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    host = app.bind(hostUses);
    host.provide(memory, fakeMemory({ [GROUP]: storedRoom(GROUP), [PRIVATE]: storedRoom(PRIVATE) }) as never);
    await app.plugin(sessionManagerPlugin);
    await app.plugin(personaPlugin, { timeInjection: false });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(personaPlugin.name)?.state, 'persona 未激活').toBe('active');
    const found = host.services.get(persona);
    if (!found) throw new Error('persona 服务未就绪');
    svc = found;
  };

  /** 经 agent:input:before 装上会话身份，在钩子链内取易变上下文 */
  const volatileFor = async (message: IncomingMessage): Promise<{ prompt: string; message: IncomingMessage }> => {
    let prompt = '';
    const data = { message, turnId: 't1', metadata: {} };
    await host.hooks.run('agent:input:before', data, async () => {
      prompt = svc.getVolatilePrompt?.() ?? '';
    });
    return { prompt, message: data.message };
  };

  afterEach(async () => {
    await app.stop();
  });

  it('定时群消息（无 sessionType）：按会话记下的聊天窗口为群聊，带群号与身份判定规则', async () => {
    await boot();
    const msg: IncomingMessage = { content: '定时提醒', sessionId: GROUP, platform: 'onebot', source: 'scheduler' };
    const { prompt, message } = await volatileFor(msg);
    expect(prompt).toContain('会话类型：群聊');
    expect(prompt).toContain('群号：20001');
    expect(prompt).toContain('身份判定');
    // 只用于提示词：消息本身不带上 sessionType
    expect(message.sessionType).toBeUndefined();
  });

  it('私聊房间：为私聊，不出群聊身份判定', async () => {
    await boot();
    const { prompt } = await volatileFor({ content: 'x', sessionId: PRIVATE, platform: 'onebot', source: 'scheduler' });
    expect(prompt).toContain('会话类型：私聊');
    expect(prompt).not.toContain('身份判定');
  });

  it('消息显式带 sessionType 时以显式值为准', async () => {
    await boot();
    const { prompt } = await volatileFor({
      content: 'x',
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'private',
    });
    expect(prompt).toContain('会话类型：私聊');
    expect(prompt).not.toContain('会话类型：群聊');
  });

  it('目标是群房间、platform 写成 internal 的定时消息：按房间记下的出生平台与聊天窗口', async () => {
    await boot();
    const { prompt } = await volatileFor({
      content: '定时提醒',
      sessionId: GROUP,
      platform: 'internal',
      source: 'scheduler',
    });
    expect(prompt).toContain('当前平台：onebot');
    expect(prompt).toContain('会话类型：群聊');
    expect(prompt).toContain('群号：20001');
  });

  it('会话表里没有来源字段的会话：不从会话 id 推，不出会话类型', async () => {
    await boot();
    await host.sessionManager.require().ensureSession('onebot:10000:group:20002');
    for (const [sessionId, platform] of [
      ['onebot:10000:group:20002', 'onebot'],
      ['onebot:10000:group:20003', 'onebot'],
      ['scheduler::group:x', 'internal'],
    ]) {
      const { prompt } = await volatileFor({ content: 'x', sessionId, platform });
      expect(prompt, `${platform} / ${sessionId}`).not.toContain('会话类型');
    }
  });

  it('子任务会话（无 sessionType）：出生平台取根会话的，不出会话类型、群号与身份判定', async () => {
    await boot();
    const sm = host.sessionManager.require();
    for (const parentId of [GROUP, PRIVATE]) {
      const child = await sm.createChildSession(parentId, { name: '<子任务>' });
      // 形状同 plugin-subtask 派发的子任务消息（平台取发起工具调用的那一轮）
      const { prompt } = await volatileFor({
        content: 'x',
        sessionId: child.id,
        platform: 'internal',
        userId: `parent:${parentId}`,
      });
      expect(prompt, child.id).toContain('当前平台：onebot');
      expect(prompt, child.id).not.toContain('会话类型');
      expect(prompt, child.id).not.toContain('群号');
      expect(prompt, child.id).not.toContain('身份判定');
    }
  });
});

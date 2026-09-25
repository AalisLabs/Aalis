import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { App, type BoundOf, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 合成回合（scheduler / workflow / delegate / idle）不经适配器，消息上没有 sessionType，
// persona 的群聊段（会话类型、群号、身份判定规则）曾因此整段缺席：LLM 不知道自己在群里。
// 现按 `<platform>:<self>:<type>:<target>` 约定从 sessionId 推断，只用于提示词、不回写消息
// （回写会把定时群消息拖进 flow-control / trigger-policy 的 *:group 闸）。
// 真 agent:input:before 钩子驱动（生产路径），在钩子链内读易变上下文。
// ════════════════════════════════════════════════════════════

const hostUses = { hooks, services };

describe('persona 合成回合的会话类型推断', () => {
  let app: App;
  let host: BoundOf<typeof hostUses>;
  let svc: PersonaService;

  const boot = async (): Promise<void> => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(personaPlugin, { timeInjection: false });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(personaPlugin.name)?.state, 'persona 未激活').toBe('active');
    host = app.bind(hostUses);
    const found = host.services.get(persona);
    if (!found) throw new Error('persona 服务未就绪');
    svc = found;
  };

  /** 经 agent:input:before 装上会话身份，在钩子链内取易变上下文 */
  const volatileFor = async (message: IncomingMessage): Promise<{ prompt: string; message: IncomingMessage }> => {
    let prompt = '';
    const data = { message, metadata: {} };
    await host.hooks.run('agent:input:before', data, async () => {
      prompt = svc.getVolatilePrompt?.() ?? '';
    });
    return { prompt, message: data.message };
  };

  afterEach(async () => {
    await app.stop();
  });

  it('定时群消息（无 sessionType）：按 sessionId 推断为群聊，带群号与身份判定规则', async () => {
    await boot();
    const msg: IncomingMessage = {
      content: '定时提醒',
      sessionId: 'onebot:10000:group:20001',
      platform: 'onebot',
      source: 'scheduler',
    };
    const { prompt, message } = await volatileFor(msg);
    expect(prompt).toContain('会话类型：群聊');
    expect(prompt).toContain('群号：20001');
    expect(prompt).toContain('身份判定');
    // 推断只用于提示词：消息本身不带上 sessionType
    expect(message.sessionType).toBeUndefined();
  });

  it('私聊 id：推断为私聊，不出群聊身份判定', async () => {
    await boot();
    const { prompt } = await volatileFor({
      content: 'x',
      sessionId: 'onebot:10000:private:30001',
      platform: 'onebot',
      source: 'scheduler',
    });
    expect(prompt).toContain('会话类型：私聊');
    expect(prompt).not.toContain('身份判定');
  });

  it('消息显式带 sessionType 时以显式值为准', async () => {
    await boot();
    const { prompt } = await volatileFor({
      content: 'x',
      sessionId: 'onebot:10000:group:20001',
      platform: 'onebot',
      sessionType: 'private',
    });
    expect(prompt).toContain('会话类型：私聊');
    expect(prompt).not.toContain('会话类型：群聊');
  });

  it('前缀与 platform 不符或段数不足：不推断', async () => {
    await boot();
    for (const [sessionId, platform] of [
      ['scheduler::group:x', 'internal'],
      ['onebot:10000:group:20001', 'internal'],
      ['onebot:group:20001', 'onebot'],
    ]) {
      const { prompt } = await volatileFor({ content: 'x', sessionId, platform });
      expect(prompt, `${platform} / ${sessionId}`).not.toContain('会话类型');
    }
  });

  it('子任务会话（`<父会话 id>::<uuid>`，带父会话 platform、无 sessionType）：不推断，不出群号与身份判定', async () => {
    await boot();
    for (const parentId of ['onebot:10000:group:20001', 'onebot:10000:private:30001']) {
      const sessionId = `${parentId}::abcd1234`;
      // 形状同 plugin-subtask 派发的子任务消息
      const { prompt } = await volatileFor({
        content: 'x',
        sessionId,
        platform: 'onebot',
        userId: `parent:${parentId}`,
      });
      expect(prompt, sessionId).toContain('# 当前会话环境');
      expect(prompt, sessionId).not.toContain('会话类型');
      expect(prompt, sessionId).not.toContain('群号');
      expect(prompt, sessionId).not.toContain('身份判定');
    }
  });
});

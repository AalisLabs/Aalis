import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import type {} from '../../packages/api-host-config/src/index.js';
import { type PersonaSessionOptions, persona } from '../../packages/api-persona/src/index.js';
import type {} from '../../packages/api-session-settings/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// 终端显示的人设名按终端会话取：人设服务按 { sessionId, platform: 'cli' } 取这个会话的卡，欢迎行、头部与回复前的署名都写
// 这张卡的名字，与回合同一口径，不是人设服务的主卡。会话设置或宿主配置变了时立即按新的名字重绘。启动真 TUI（假 TTY，收集
// stdout 帧），人设服务是按会话给名字的替身
// ════════════════════════════════════════════════════════════

const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe('终端显示的人设名', () => {
  /** 启动终端界面；返回发一条回复之后的最后一帧（去掉控制序列）与收到的人设选项 */
  async function terminal(getPersonaName: (options?: PersonaSessionOptions) => string) {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    cleanups.push(fakeTty(30, 120).restore);
    const app = new App({ name: 'T', logLevel: 'error' });
    provideEvents(app);
    cleanups.push(() => app.stop());
    const host = app.bind({ provide, events });
    const asked: Array<PersonaSessionOptions | undefined> = [];
    host.provide.use(persona, {
      getPersonaName: (options?: PersonaSessionOptions) => {
        asked.push(options);
        return getPersonaName(options);
      },
    } as never);
    await app.plugin(cliPlugin, { startupView: 'chat' });
    await app.plugins.idle();
    if (app.plugins.getPlugin(cliPlugin.name)?.state !== 'active') throw new Error('plugin-cli 未激活');
    await app.start();
    await settle();
    const frame = () => {
      const all = writes.join('');
      return all.slice(all.lastIndexOf(FRAME_SPLIT)).replace(ANSI_RE, '');
    };
    await host.events.use.emit('outbound:message', { sessionId: 'cli-default', platform: 'cli', content: '<回复>' });
    await vi.waitFor(() => expect(frame()).toContain('<回复>'));
    return { frame, asked, emit: host.events.use.emit };
  }

  it('按终端会话取卡：欢迎行、头部与回复的署名写这个会话的卡的名字', async () => {
    const { frame, asked } = await terminal(options =>
      options?.sessionId === 'cli-default' && options.platform === 'cli' ? '<会话的卡的名字>' : '<主卡的名字>',
    );
    expect(frame()).toContain('✦ <会话的卡的名字>');
    expect(frame()).toContain('欢迎使用 <会话的卡的名字>。');
    expect(frame()).toContain('Aalis · <会话的卡的名字>');
    expect(frame()).not.toContain('<主卡的名字>');
    expect(asked.every(options => options?.sessionId === 'cli-default' && options.platform === 'cli')).toBe(true);
  });

  it('会话用的卡没取名（名字是空串）：欢迎行与署名写 Aalis，头部写 -', async () => {
    const { frame } = await terminal(() => '');
    expect(frame()).toContain('✦ Aalis');
    expect(frame()).toContain('欢迎使用 Aalis。');
    expect(frame()).toContain('Aalis · -');
  });

  it('会话设置或宿主配置变了：立即按新的名字重绘', async () => {
    let name = '<旧名字>';
    const { frame, emit } = await terminal(() => name);
    expect(frame()).toContain('Aalis · <旧名字>');
    name = '<新名字>';
    await emit('session-settings:changed');
    await vi.waitFor(() => expect(frame()).toContain('Aalis · <新名字>'));
    name = '<再改的名字>';
    await emit('host-config:changed', { instanceId: '@aalis/plugin-persona' });
    await vi.waitFor(() => expect(frame()).toContain('Aalis · <再改的名字>'));
  });
});

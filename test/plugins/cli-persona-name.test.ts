import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PersonaSessionOptions, persona } from '../../packages/api-persona/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import { PERSONA, startSessionManager } from '../fixtures/session-settings.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// 终端显示的人设名按终端会话生效的「人设」取：欢迎行、头部与回复前的署名都写这个会话实际用的那张卡，与回合同一口径，
// 不是人设服务的主卡。起真 TUI（假 TTY，收集 stdout 帧），会话设置是真的会话管理，人设服务是按卡名给名字的替身
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
  it('owner 在全局默认层设了别的人设：欢迎行、头部与回复的署名写它的名字', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    cleanups.push(fakeTty(30, 120).restore);
    const { app, host } = await startSessionManager({
      layers: { defaults: { persona: '<别的卡>' } },
      settings: [PERSONA],
    });
    cleanups.push(() => app.stop());
    const names: Record<string, string> = { '<别的卡>': '<别的卡的名字>' };
    host.provide.use(persona, {
      getPersonaName: (options?: PersonaSessionOptions) => names[options?.persona ?? ''] ?? '<主卡的名字>',
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
    await vi.waitFor(() => expect(frame()).toContain('✦ <别的卡的名字>'));
    expect(frame()).toContain('欢迎使用 <别的卡的名字>。');
    expect(frame()).toContain('Aalis · <别的卡的名字>');
    expect(frame()).not.toContain('<主卡的名字>');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { App, definePlugin, lifecycle, provide } from '../../packages/core/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 指令执行途中被中止（处理函数抛的是中止原因，如所属插件停用、停机时随本插件这次激活的信号停下）：不是执行失败，回「已中止」，
// 不记 error。走真注册表，日志器记下 error。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('指令执行途中被中止', () => {
  it('所属插件停用、处理函数按本插件的中止原因抛出：回执是已中止，不是失败，没有 error 日志', async () => {
    const errors: string[] = [];
    const logger = {
      warn() {},
      debug() {},
      info() {},
      error: (message: string) => {
        errors.push(message);
      },
      child: () => logger,
    };
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    const registry = new CommandRegistry(logger as never, ref(), ref());
    app.bind({ provide }).provide.use(commands, registry);
    let running = false;
    const owner = definePlugin({
      name: 'zz-command-owner',
      uses: { commands, lifecycle },
      apply({ commands, lifecycle }) {
        const { signal } = lifecycle.use;
        commands.use.command('slow', 'zz').action(
          () =>
            new Promise<string>((_, reject) => {
              running = true;
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        );
      },
    });
    await app.plugin(owner);
    await app.plugins.idle();

    const reply = registry.run('slow', {
      args: [],
      raw: '/slow',
      sessionId: 'zz-session',
      platform: 'test',
      userId: 'zz-user',
      sessionType: 'private',
    });
    await expect.poll(() => running).toBe(true);
    await app.plugins.disable(owner.name);
    expect(toSource((await reply) ?? '')).toBe('指令 /slow 已中止');
    expect(errors).toEqual([]);
  });
});

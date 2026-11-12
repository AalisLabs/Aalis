import { commands } from '../../packages/api-commands/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type App, definePlugin, provide } from '../../packages/core/src/index.js';
import type { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 清消息历史与删会话的测试件：装上 /clear、在 WebUI 会话里敲一条指令、在删除或清理的一段里阻塞一家。
// ════════════════════════════════════════════════════════════

/** 装上 plugin-commands（网关是替身），清消息历史由它的 /clear 发起 */
export async function withCommands(app: App): Promise<void> {
  app.bind({ provide }).provide.use(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  await app.plugin(commandsPlugin, {});
}

/** owner 在这个 WebUI 会话里敲一条指令（指令守卫放行），交回回执 */
export async function command(app: App, sessionId: string, line: string): Promise<string | undefined> {
  const registry = app.bind({ commands }).commands.use as unknown as CommandRegistry;
  registry.setExecutionGuard(async () => ({ ok: true }));
  const parsed = registry.parseCommand(line);
  if (!parsed) throw new Error(`不是指令: ${line}`);
  return registry.execute(parsed.name, {
    sessionId,
    platform: 'webui',
    userId: 'console',
    sessionType: 'private',
    args: parsed.args,
    raw: parsed.raw,
  });
}

/**
 * 删除或清理的一段里阻塞一家：只听 session:deleted 的一家（收到就阻塞），或先清再调 next 的一家清理（如人设、检查点）。entered
 * 在它第一次阻塞时落定，release 之后放行（之后的不再阻塞）
 */
export function hanging(on: 'session:deleted' | 'memory:clear') {
  const entered = deferred();
  const gate = deferred();
  const hang = async () => {
    entered.resolve();
    await gate.promise;
  };
  const plugin = definePlugin({
    name: `zz-hanging-${on.replace(':', '-')}`,
    uses: { events, hooks },
    apply: caps => {
      if (on === 'session:deleted') caps.events.use.on('session:deleted', hang);
      else
        caps.hooks.use.middleware('memory:clear', async (_data, next) => {
          await hang();
          await next();
        });
    },
  });
  const install = async (app: App): Promise<void> => {
    await app.plugin(plugin);
  };
  return { install, entered: entered.promise, release: () => gate.resolve() };
}

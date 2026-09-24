import type { IncomingMessage } from '@aalis/schema-message';
import { afterEach, describe, expect, it } from 'vitest';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';

// ════════════════════════════════════════════════════════════
// delegate_to_session 的授权身份透传（schema-message actor 契约）。
//
// 契约要求触发器 snapshot 调用者身份、触发时回填 actor；目标 agent 构造
// ToolCallContext 时优先读 actor，authority 按 (platform, userId) 实时查等级。
// 关键不变量：
//   1. 有身份 → 原样透传（权限跟人走，owner 委派出去才有 owner 能力）；
//   2. 匿名 → 不发明身份（缺省留空 = defaultAuthority，不可提升）；
//   3. actor 只来自 callCtx snapshot，绝不从 LLM 工具入参里读（防提权）。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, callCtx: Record<string, unknown>) => Promise<string>;

const booted: App[] = [];

afterEach(async () => {
  for (const app of booted.splice(0)) await app.stop();
});

/** 真实 App 装载插件；tools 由宿主提供桩实现以捕获注册的 handler，事件走真实总线 */
async function setup(): Promise<{ handlers: Map<string, Handler>; emitted: IncomingMessage[] }> {
  const app = new App({ name: 'T', logLevel: 'error' });
  booted.push(app);
  const host = app.bind({ provide, events });

  const handlers = new Map<string, Handler>();
  host.provide(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      const name = tool.definition.function.name;
      handlers.set(name, tool.handler as unknown as Handler);
      return () => void handlers.delete(name);
    },
    registerGroup: () => () => {},
  } as never);

  const emitted: IncomingMessage[] = [];
  host.events.on('inbound:message', message => {
    emitted.push(message);
  });

  await app.plugins.register(sessionTools, {});
  await app.plugins.idle();
  return { handlers, emitted };
}

describe('delegate_to_session actor 透传', () => {
  it('有身份的调用者：actor 原样回填进下游 IncomingMessage', async () => {
    const { handlers, emitted } = await setup();
    const handler = handlers.get('delegate_to_session');
    expect(handler, 'delegate_to_session 未注册').toBeDefined();

    const res = JSON.parse(
      await handler!(
        { target_session_id: 'onebot:1:group:2', task: '去做某事', wait_for_result: false },
        { sessionId: 'src-session', platform: 'onebot', userId: 'user-a' },
      ),
    );
    expect(res.delegated).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].triggerType).toBe('proactive');
    expect(emitted[0].actor).toEqual({ platform: 'onebot', userId: 'user-a' });
  });

  it('匿名调用者：不发明身份，actor 缺省（目标落 defaultAuthority）', async () => {
    const { handlers, emitted } = await setup();
    const handler = handlers.get('delegate_to_session')!;

    await handler(
      { target_session_id: 'onebot:1:group:3', task: '去做某事', wait_for_result: false },
      { sessionId: 'src-session' },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].actor).toBeUndefined();
  });

  it('链式委派：callCtx.actor 优先于物理身份（A 替 X 运行时再委派，X 一路传递）', async () => {
    const { handlers, emitted } = await setup();
    const handler = handlers.get('delegate_to_session')!;

    await handler(
      { target_session_id: 'onebot:1:group:9', task: '去做某事', wait_for_result: false },
      { sessionId: 'src', platform: 'onebot', userId: 'phys-sender', actor: { platform: 'webui', userId: 'console' } },
    );
    expect(emitted[0].actor).toEqual({ platform: 'webui', userId: 'console' });
  });

  it('wait_for_result=true 分支：同一 incoming 对象，actor 同样在场（超时路径回归）', async () => {
    const { handlers, emitted } = await setup();
    const handler = handlers.get('delegate_to_session')!;

    const res = JSON.parse(
      await handler(
        { target_session_id: 'onebot:1:group:10', task: '去做某事', wait_for_result: true, timeout_seconds: 1 },
        { sessionId: 'src', platform: 'onebot', userId: 'user-a' },
      ),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].actor).toEqual({ platform: 'onebot', userId: 'user-a' });
    expect(res.outcome ?? res.error ?? '').toBeDefined();
  }, 8000);

  it('actor 只认 callCtx snapshot，LLM 工具入参无法指定身份（防提权）', async () => {
    const { handlers, emitted } = await setup();
    const handler = handlers.get('delegate_to_session')!;

    await handler(
      {
        target_session_id: 'onebot:1:group:4',
        task: '去做某事',
        wait_for_result: false,
        actor: { platform: 'webui', userId: 'console' },
        actor_platform: 'webui',
        actor_user_id: 'console',
      },
      { sessionId: 'src-session', platform: 'onebot', userId: 'user-b' },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].actor).toEqual({ platform: 'onebot', userId: 'user-b' });
  });
});

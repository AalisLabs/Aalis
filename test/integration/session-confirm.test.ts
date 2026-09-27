import { describe, expect, it } from 'vitest';
import { type AccessConfirmHandler, type AccessRequest, authority } from '../../packages/api-authority/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import sessionConfirmPlugin from '../../packages/plugin-session-confirm/src/index.js';
import subtaskPlugin from '../../packages/plugin-subtask/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

type ToolHandler = (args: Record<string, unknown>, callCtx: Record<string, unknown>) => Promise<string>;

// ════════════════════════════════════════════════════════════
// 端到端：统一会话确认环路（轴 B 的交互通道）
//   真实 plugin-gateway + plugin-session-confirm + stub authority。
//   验证：requestAccess→'*' handler→经总线发提示→用户回复经 inbound:confirm 相位
//         被拦截解析并 resolve，且**吞掉回复不触达 agent**（防 abort 在途生成）。
// ════════════════════════════════════════════════════════════

const tick = () => new Promise(r => setTimeout(r, 0));

async function setup() {
  const app = new App({ name: 'SC', logLevel: 'error' });
  await registerHubs(app);
  let starHandler: AccessConfirmHandler | undefined;
  const stubAuthority = {
    setConfirmHandler: (platform: string, h: AccessConfirmHandler) => {
      if (platform === '*') starHandler = h;
      return () => {
        if (platform === '*' && starHandler === h) starHandler = undefined;
      };
    },
  };
  await app.plugins.register(gatewayPlugin);
  // 宿主侧绑一次复用：provide 挂 authority 桩，events 充当平台适配器的收发口
  const host = app.bind({ provide, events });
  host.provide(authority, stubAuthority as never);
  await app.plugins.register(sessionConfirmPlugin);
  await tick();
  return { app, host, getHandler: () => starHandler };
}

const req = (sessionId: string, confirm: 'session' | 'always' = 'session'): AccessRequest => ({
  name: 'shell.exec',
  type: 'tool',
  capability: 'tool:shell.exec',
  sessionId,
  platform: 'onebot',
  confirm,
});

describe('plugin-session-confirm 端到端确认环路', () => {
  it('注册 "*" fallback handler', async () => {
    const { app, getHandler } = await setup();
    try {
      expect(getHandler()).toBeTypeOf('function');
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('卸载插件即注销 "*" handler：authority 不再把确认投给已死通道等到超时', async () => {
    const { app, getHandler } = await setup();
    try {
      expect(getHandler()).toBeTypeOf('function');
      await app.plugins.unload('@aalis/plugin-session-confirm');
      expect(getHandler()).toBeUndefined();
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('回复 Y → 经总线发提示 + inbound:confirm 拦截解析为「允许本次」+ 吞掉回复', async () => {
    const { app, host, getHandler } = await setup();
    try {
      const outbound: string[] = [];
      host.events.on('outbound:message', m => {
        outbound.push(m.content);
      });
      let confirmSwallowed = false;
      host.events.on('gateway:phase:done', d => {
        if (d.phase === 'inbound:confirm' && d.reachedEnd === false) confirmSwallowed = true;
      });

      const decisionP = getHandler()!(req('sess-Y'));
      await tick(); // 让 dispatchOutbound→outbound:message 派发
      expect(outbound.length).toBe(1);
      expect(outbound[0]).toContain('回复 Y');

      host.events.emit('inbound:message', { content: ' y ', sessionId: 'sess-Y', platform: 'onebot' });
      const decision = await decisionP;
      expect(decision).toEqual({ allowed: true, grant: { scope: 'once' } });
      await tick(); // 等 processInbound 把 gateway:phase:done 派发完
      expect(confirmSwallowed).toBe(true); // 回复被吞，未进入 command/dispatch（不会 abort 在途生成）
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('回复 YS → 本会话授予；回复其他 → 取消', async () => {
    const { app, host, getHandler } = await setup();
    try {
      const ys = getHandler()!(req('sess-YS'));
      await tick();
      host.events.emit('inbound:message', { content: 'YS', sessionId: 'sess-YS', platform: 'onebot' });
      expect(await ys).toEqual({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } });

      const cancel = getHandler()!(req('sess-N'));
      await tick();
      host.events.emit('inbound:message', { content: '不要', sessionId: 'sess-N', platform: 'onebot' });
      expect(await cancel).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('confirm="always" → 不接受 YS 会话记忆，仅本次允许', async () => {
    const { app, host, getHandler } = await setup();
    try {
      const p = getHandler()!(req('sess-AL', 'always'));
      await tick();
      host.events.emit('inbound:message', { content: 'YS', sessionId: 'sess-AL', platform: 'onebot' });
      expect(await p).toEqual({ allowed: true }); // always：允许但无会话授予
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('不同 session 的回复互不串台', async () => {
    const { app, host, getHandler } = await setup();
    try {
      const a = getHandler()!(req('sess-1'));
      const b = getHandler()!(req('sess-2'));
      await tick();
      host.events.emit('inbound:message', { content: 'Y', sessionId: 'sess-2', platform: 'onebot' });
      expect(await b).toEqual({ allowed: true, grant: { scope: 'once' } });
      host.events.emit('inbound:message', { content: '取消', sessionId: 'sess-1', platform: 'onebot' });
      expect(await a).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('C1: 群里只有触发者本人能确认，第三方抢答无效', async () => {
    const { app, host, getHandler } = await setup();
    try {
      // alice 在群 sess-G 触发确认
      const p = getHandler()!({ ...req('sess-G'), userId: 'alice' });
      await tick();
      // bob 抢答 Y → 不被消费（feed 返回 false，消息照常放行），确认仍挂着
      host.events.emit('inbound:message', {
        content: 'Y',
        sessionId: 'sess-G',
        platform: 'onebot',
        userId: 'bob',
      });
      await tick();
      // alice 本人回「取消」→ 被消费；若 bob 的 Y 曾误生效，这里会是 {allowed:true} 而非 false
      host.events.emit('inbound:message', {
        content: '取消',
        sessionId: 'sess-G',
        platform: 'onebot',
        userId: 'alice',
      });
      expect(await p).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('提示带参数摘要：只展示白名单键的首行并限长', async () => {
    const { app, host, getHandler } = await setup();
    try {
      const outbound: string[] = [];
      host.events.on('outbound:message', m => {
        outbound.push(m.content);
      });
      const decisionP = getHandler()!({
        ...req('sess-args'),
        args: { command: 'rm -rf build\n && echo done', secret: 'do-not-show', path: 'workspace:/a.txt' },
      });
      await tick();
      expect(outbound[0]).toContain('command=rm -rf build');
      expect(outbound[0]).toContain('path=workspace:/a.txt');
      expect(outbound[0]).not.toContain('echo done'); // 只取首行
      expect(outbound[0]).not.toContain('do-not-show'); // 非白名单键不展示
      host.events.emit('inbound:message', { content: 'n', sessionId: 'sess-args', platform: 'onebot' });
      expect(await decisionP).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('提示带 name 参数摘要：skill_delete 等以 name 为唯一参数的工具不只显示工具名', async () => {
    const { app, host, getHandler } = await setup();
    try {
      const outbound: string[] = [];
      host.events.on('outbound:message', m => {
        outbound.push(m.content);
      });
      const decisionP = getHandler()!({ ...req('sess-name'), name: 'skill_delete', args: { name: 'my-skill' } });
      await tick();
      expect(outbound[0]).toContain('name=my-skill');
      host.events.emit('inbound:message', { content: 'n', sessionId: 'sess-name', platform: 'onebot' });
      expect(await decisionP).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('安全：带 source 的内部注入不当作确认应答：无 userId 的待决确认不被它结算，注入照常放行', async () => {
    const { app, host, getHandler } = await setup();
    try {
      let swallowed = false;
      host.events.on('gateway:phase:done', d => {
        if (d.phase === 'inbound:confirm' && d.reachedEnd === false) swallowed = true;
      });
      // 定时任务等无 userId 的回合发起的确认：应答者同为 undefined 时才算本人
      let settled = false;
      const pending = getHandler()!(req('sess-src')).then(d => {
        settled = true;
        return d;
      });
      await tick();
      // 后台命令的结束通知（宿主通知，带 source、不带 userId）到达
      host.events.emit('inbound:message', {
        content: '后台进程 proc_0a1b2c_1 已退出：退出码 0，用时 3 秒。它最近的输出用 process_read 查看。',
        sessionId: 'sess-src',
        platform: 'onebot',
        source: 'exec-bg:proc_0a1b2c_1',
      });
      await tick();
      await tick();
      expect(swallowed, '通知不应被确认相位吞掉').toBe(false);
      expect(settled, '确认不应被通知结算').toBe(false);
      host.events.emit('inbound:message', { content: 'n', sessionId: 'sess-src', platform: 'onebot' });
      expect(await pending).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('安全：父会话经 send_to_subtask 发来的 ys 不批准子会话里的确认（子任务回合与这条中继同为 parent:<父会话>）', async () => {
    const { app, host, getHandler } = await setup();
    try {
      const PARENT = 'cli-default';
      const CHILD = `${PARENT}::abcd1234`;
      const handlers = new Map<string, ToolHandler>();
      host.provide(tools, {
        register(tool: { definition: { function: { name: string } }; handler: ToolHandler }) {
          handlers.set(tool.definition.function.name, tool.handler);
          return () => void handlers.delete(tool.definition.function.name);
        },
        registerGroup: () => () => {},
      } as never);
      host.provide(sessionManager, {
        getSession: (id: string) => (id === CHILD ? { id, parentId: PARENT, status: 'active' } : undefined),
        updateSession: async () => {},
      } as never);
      await app.plugins.register(subtaskPlugin, {});
      await app.plugins.idle();

      let swallowed = false;
      let dispatched = false;
      host.events.on('gateway:phase:done', d => {
        if (d.phase === 'inbound:confirm' && d.reachedEnd === false) swallowed = true;
        if (d.phase === 'inbound:dispatch') dispatched = true;
      });
      // 子任务回合里的工具确认：工具调用上下文的 userId 是子任务消息的 userId
      let settled = false;
      const pending = getHandler()!({ ...req(CHILD), platform: 'cli', userId: `parent:${PARENT}` }).then(d => {
        settled = true;
        return d;
      });
      await tick();

      const sent = await handlers.get('send_to_subtask')!(
        { subtask_id: CHILD, message: 'ys' },
        { sessionId: PARENT, platform: 'cli', userId: 'console' },
      );
      expect(JSON.parse(sent)).toMatchObject({ sent: true });
      await tick();
      await tick();
      expect(swallowed, '中继消息不应被确认相位当作应答吞掉').toBe(false);
      expect(settled, '确认不应被父会话的中继批准').toBe(false);
      expect(dispatched, '中继消息照常送达子任务').toBe(true);

      host.events.emit('inbound:message', {
        content: 'n',
        sessionId: CHILD,
        platform: 'cli',
        userId: `parent:${PARENT}`,
      });
      expect(await pending).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('发起回合中止：撤回未决确认并按取消结算，队列推进到下一个', async () => {
    const { app, host, getHandler } = await setup();
    try {
      const outbound: string[] = [];
      host.events.on('outbound:message', m => {
        outbound.push(m.content);
      });
      const ac = new AbortController();
      const first = getHandler()!({ ...req('sess-abort'), signal: ac.signal });
      const second = getHandler()!({ ...req('sess-abort'), name: 'file_write', args: { path: 'workspace:/b.txt' } });
      await tick();
      expect(outbound).toHaveLength(1); // 只有队首在问
      ac.abort();
      expect(await first).toBe(false);
      await tick();
      expect(outbound[1]).toContain('回合已中止'); // 撤回告知
      expect(outbound[2]).toContain('file_write'); // 推进到下一个未决确认
      host.events.emit('inbound:message', { content: 'y', sessionId: 'sess-abort', platform: 'onebot' });
      expect(await second).toEqual({ allowed: true, grant: { scope: 'once' } });
    } finally {
      await app.stop().catch(() => {});
    }
  });
});

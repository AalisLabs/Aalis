import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import type { AccessConfirmHandler, AccessRequest } from '../../packages/plugin-authority-api/src/index.js';
import * as gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import * as sessionConfirmPlugin from '../../packages/plugin-session-confirm/src/index.js';

// ════════════════════════════════════════════════════════════
// 端到端：统一会话确认环路（轴 B 的交互通道）
//   真实 plugin-gateway + plugin-session-confirm + stub authority。
//   验证：requestAccess→'*' handler→经总线发提示→用户回复经 inbound:confirm 相位
//         被拦截解析并 resolve，且**吞掉回复不触达 agent**（防 abort 在途生成）。
// ════════════════════════════════════════════════════════════

const tick = () => new Promise(r => setTimeout(r, 0));

async function setup() {
  const app = new App({ config: { name: 'SC', logLevel: 'error', plugins: {} } });
  let starHandler: AccessConfirmHandler | undefined;
  const stubAuthority = {
    setConfirmHandler: (platform: string, h: AccessConfirmHandler) => {
      if (platform === '*') starHandler = h;
    },
  };
  await app.plugins.register(gatewayPlugin as never);
  app.ctx.provide('authority', stubAuthority as never);
  await app.plugins.register(sessionConfirmPlugin as never);
  await tick();
  return { app, getHandler: () => starHandler };
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

  it('回复 Y → 经总线发提示 + inbound:confirm 拦截解析为「允许本次」+ 吞掉回复', async () => {
    const { app, getHandler } = await setup();
    try {
      const outbound: string[] = [];
      app.ctx.on('outbound:message', ((m: { content: string }) => outbound.push(m.content)) as never);
      let confirmSwallowed = false;
      app.ctx.on('gateway:phase:done', ((d: { phase: string; reachedEnd: boolean }) => {
        if (d.phase === 'inbound:confirm' && d.reachedEnd === false) confirmSwallowed = true;
      }) as never);

      const decisionP = getHandler()!(req('sess-Y'));
      await tick(); // 让 dispatchOutbound→outbound:message 派发
      expect(outbound.length).toBe(1);
      expect(outbound[0]).toContain('回复 Y');

      app.ctx.emit('inbound:message', { content: ' y ', sessionId: 'sess-Y', platform: 'onebot' } as never);
      const decision = await decisionP;
      expect(decision).toEqual({ allowed: true, grant: { scope: 'once' } });
      await tick(); // 等 processInbound 把 gateway:phase:done 派发完
      expect(confirmSwallowed).toBe(true); // 回复被吞，未进入 command/dispatch（不会 abort 在途生成）
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('回复 YS → 本会话授予；回复其他 → 取消', async () => {
    const { app, getHandler } = await setup();
    try {
      const ys = getHandler()!(req('sess-YS'));
      await tick();
      app.ctx.emit('inbound:message', { content: 'YS', sessionId: 'sess-YS', platform: 'onebot' } as never);
      expect(await ys).toEqual({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } });

      const cancel = getHandler()!(req('sess-N'));
      await tick();
      app.ctx.emit('inbound:message', { content: '不要', sessionId: 'sess-N', platform: 'onebot' } as never);
      expect(await cancel).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('confirm="always" → 不接受 YS 会话记忆，仅本次允许', async () => {
    const { app, getHandler } = await setup();
    try {
      const p = getHandler()!(req('sess-AL', 'always'));
      await tick();
      app.ctx.emit('inbound:message', { content: 'YS', sessionId: 'sess-AL', platform: 'onebot' } as never);
      expect(await p).toEqual({ allowed: true }); // always：允许但无会话授予
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('不同 session 的回复互不串台', async () => {
    const { app, getHandler } = await setup();
    try {
      const a = getHandler()!(req('sess-1'));
      const b = getHandler()!(req('sess-2'));
      await tick();
      app.ctx.emit('inbound:message', { content: 'Y', sessionId: 'sess-2', platform: 'onebot' } as never);
      expect(await b).toEqual({ allowed: true, grant: { scope: 'once' } });
      app.ctx.emit('inbound:message', { content: '取消', sessionId: 'sess-1', platform: 'onebot' } as never);
      expect(await a).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });

  it('C1: 群里只有触发者本人能确认，第三方抢答无效', async () => {
    const { app, getHandler } = await setup();
    try {
      // alice 在群 sess-G 触发确认
      const p = getHandler()!({ ...req('sess-G'), userId: 'alice' });
      await tick();
      // bob 抢答 Y → 不被消费（feed 返回 false，消息照常放行），确认仍挂着
      app.ctx.emit('inbound:message', {
        content: 'Y',
        sessionId: 'sess-G',
        platform: 'onebot',
        userId: 'bob',
      } as never);
      await tick();
      // alice 本人回「取消」→ 被消费；若 bob 的 Y 曾误生效，这里会是 {allowed:true} 而非 false
      app.ctx.emit('inbound:message', {
        content: '取消',
        sessionId: 'sess-G',
        platform: 'onebot',
        userId: 'alice',
      } as never);
      expect(await p).toBe(false);
    } finally {
      await app.stop().catch(() => {});
    }
  });
});

import { App, services } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { commands as commandsDescriptor, type ExecutionInput } from '../../packages/api-commands/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import type { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// commands 的 inbound 相位：actor 消费端 + 经 owner 审批的注入
//
// 补的是一条**链条断在消费端**的缺口。scheduler 侧已经有测试钉住「触发时发出的
// message.actor 是谁」（见 scheduler-actor-identity.test.ts），但没有任何测试验证
// commands 真的**读**它。实测：把 `message.actor?.platform ?? message.platform` 改成
// 直接用 `message.platform`，全量 1181 个用例零转红——上游把身份设对了，下游改成不看，
// 整条权限链断掉而无人知晓。
//
// 同一段里的 `skipConfirm` 也要钉：改成恒 true（即任何来源都免确认）曾经全绿。它只给声明了
// ownerApproved 的注入（定时任务），改错等于把豁免发给所有人。
// ════════════════════════════════════════════════════════════

interface Captured {
  input?: ExecutionInput;
}

async function runInbound(message: Record<string, unknown>): Promise<Captured> {
  const app = new App({ logLevel: 'error' });
  await registerHubs(app);
  await app.plugin(gatewayPlugin);
  await app.plugin(commandsPlugin);
  await app.plugins.idle();

  const host = app.bind({ events, services });
  const captured: Captured = {};
  const commands = host.services.use.get(commandsDescriptor) as CommandRegistry | undefined;
  if (!commands) throw new Error('commands 服务未注册');
  commands.command('probe', '探针').action(async function (this: unknown) {
    return 'ok';
  });
  // 包一层 run（聊天入站执行指令的入口）抓真实入参——断言的是「传下去的身份」，不是「谁注册了指令」。
  const orig = commands.run.bind(commands);
  commands.run = async (name: string, input: ExecutionInput) => {
    captured.input = input;
    return orig(name, input);
  };

  await host.events.use.emit('inbound:message', message as never);
  await app.stop();
  return captured;
}

const base = { content: '/probe', sessionId: 'internal', platform: 'internal', sessionType: 'private' as const };
const approved = { ...base, source: 'scheduler', ownerApproved: true };

describe('commands 消费 message.actor 与 ownerApproved', () => {
  it('带 actor 时按 actor 的身份裁决（不是消息原始身份）', async () => {
    const { input } = await runInbound({
      ...approved,
      userId: 'anonymous-inbound',
      actor: { platform: 'onebot', userId: '10001' },
    });
    expect(input, '中间件没跑到 execute，本用例没测到东西').toBeDefined();
    expect(
      { platform: input?.platform, userId: input?.userId },
      'actor 没被消费——scheduler 固化的创建者身份被丢弃，权限按消息原始身份裁决',
    ).toEqual({ platform: 'onebot', userId: '10001' });
  });

  it('无 actor 时回落消息原始身份', async () => {
    const { input } = await runInbound({ ...base, platform: 'onebot', userId: 'alice' });
    expect({ platform: input?.platform, userId: input?.userId }).toEqual({ platform: 'onebot', userId: 'alice' });
  });

  it('声明了 ownerApproved 的注入才给 skipConfirm', async () => {
    const { input } = await runInbound({ ...approved, userId: 'u' });
    expect(input?.skipConfirm, 'cron 上下文无人可点确认框，经 owner 审批的注入必须免确认').toBe(true);
  });

  it('普通消息不得拿到 skipConfirm（否则豁免发给了所有人）', async () => {
    const { input } = await runInbound({ ...base, platform: 'onebot', userId: 'alice' });
    expect(input?.skipConfirm, 'skipConfirm 泄漏给普通用户——受限操作的二次确认形同虚设').toBeFalsy();
  });
});

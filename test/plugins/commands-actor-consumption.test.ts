import { App, events, services } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { commands as commandsDescriptor, type ExecutionInput } from '../../packages/api-commands/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';

// ════════════════════════════════════════════════════════════
// commands 的 inbound 相位：actor 消费端 + 受信系统源判定
//
// 补的是一条**链条断在消费端**的缺口。scheduler 侧已经有测试钉住「触发时发出的
// message.actor 是谁」（见 scheduler-actor-identity.test.ts），但没有任何测试验证
// commands 真的**读**它。实测：把 `message.actor?.platform ?? message.platform` 改成
// 直接用 `message.platform`，全量 1181 个用例零转红——上游把身份设对了，下游改成不看，
// 整条权限链断掉而无人知晓。
//
// 同一段里的 `skipConfirm: isSystemTrigger` 也零覆盖：改成恒 true（即任何来源都免确认）
// 同样全绿。它决定「cron 上下文免二次确认」这条豁免给不给，改错等于把豁免发给所有人。
// ════════════════════════════════════════════════════════════

interface Captured {
  input?: ExecutionInput;
}

async function runInbound(message: Record<string, unknown>): Promise<Captured> {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.plugin(gatewayPlugin);
  await app.plugin(commandsPlugin);
  await app.plugins.idle();

  const host = app.bind({ events, services });
  const captured: Captured = {};
  const commands = host.services.get(commandsDescriptor);
  if (!commands) throw new Error('commands 服务未注册');
  commands.command('probe', '探针').action(async function (this: unknown) {
    return 'ok';
  });
  // 包一层 execute 抓真实入参——断言的是「传下去的身份」，不是「谁注册了指令」。
  const orig = commands.execute.bind(commands);
  commands.execute = async (name: string, input: ExecutionInput) => {
    captured.input = input;
    return orig(name, input);
  };

  await host.events.emit('inbound:message', message as never);
  await app.stop();
  return captured;
}

const base = { content: '/probe', sessionId: 'internal', platform: 'internal', sessionType: 'private' as const };

describe('commands 消费 message.actor 与受信系统源', () => {
  it('带 actor 时按 actor 的身份裁决（不是消息原始身份）', async () => {
    const { input } = await runInbound({
      ...base,
      userId: 'anonymous-inbound',
      source: 'scheduler',
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

  it('受信系统源（scheduler）才给 skipConfirm', async () => {
    const { input } = await runInbound({ ...base, userId: 'u', source: 'scheduler' });
    expect(input?.skipConfirm, 'cron 上下文无人可点确认框，受信源必须免确认').toBe(true);
  });

  it('普通消息不得拿到 skipConfirm（否则豁免发给了所有人）', async () => {
    const { input } = await runInbound({ ...base, platform: 'onebot', userId: 'alice' });
    expect(input?.skipConfirm, 'skipConfirm 泄漏给普通用户——受限操作的二次确认形同虚设').toBeFalsy();
  });

  it('伪造的 source 不在白名单内则不给 skipConfirm', async () => {
    const { input } = await runInbound({ ...base, userId: 'u', source: 'not-a-trusted-source' });
    expect(input?.skipConfirm).toBeFalsy();
  });

  it('workflow 派发不受信（2026-08-28 审计：workflow_define/run 仅 L1，受信会绕过 confirm 闸）', async () => {
    // workflow send-message 节点可向任意会话投递 /clear 这类 0 级+confirm 命令；
    // define/run 只 sensitive(L1)、零确认，故 workflow 派发**不给** skipConfirm，
    // 命令照常走 confirm（虚拟会话无人应答即超时拒，fail-closed）。
    const { input } = await runInbound({ ...base, userId: 'u', source: 'workflow:wf1:node2' });
    expect(input?.skipConfirm, 'workflow 不该受信——否则 L1 绕过 confirm 向任意会话投命令').toBeFalsy();
  });

  it("'system' 死项已删——不受信（全仓无入站生产者，仅出站消息用该值）", async () => {
    const { input } = await runInbound({ ...base, userId: 'u', source: 'system' });
    expect(input?.skipConfirm).toBeFalsy();
  });

  it('唯一受信源是 scheduler（它建任务的入口 dangerous+always-confirm，特权与成本相称）', async () => {
    const { input } = await runInbound({ ...base, userId: 'u', source: 'scheduler' });
    expect(input?.skipConfirm).toBe(true);
  });
});

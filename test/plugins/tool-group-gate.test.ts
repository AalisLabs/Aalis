import type { Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';

// ════════════════════════════════════════════════════════════
// 分组闸此前只在列举面（getDefinitions/getSummaries）生效，execute 按名直调完全不校验。
// 被提示注入的模型可以叫出一个本回合没下发给它的名字（安全模型把 LLM 输出列为不可信），
// 于是 onebot 群会话里未暴露分组的工具照样执行——而「不在 enabledGroups 里故不可达」
// 正是 http_request 等 public 破坏性工具在多人平台上的前提判据。
// ════════════════════════════════════════════════════════════

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

interface Probe {
  reg: ToolRegistry;
  ran: () => boolean;
}

function setup(): Probe {
  const reg = new ToolRegistry(makeLogger());
  let ran = false;
  reg.register(
    {
      definition: {
        type: 'function',
        function: {
          name: 'probe_grouped',
          description: '带分组的工具',
          parameters: { type: 'object', properties: {} },
        },
      },
      groups: ['system'],
      handler: async () => {
        ran = true;
        return 'HANDLER-RAN';
      },
    },
    'probe-plugin',
  );
  reg.register(
    {
      definition: {
        type: 'function',
        function: {
          name: 'probe_plain',
          description: '无分组通用工具',
          parameters: { type: 'object', properties: {} },
        },
      },
      handler: async () => 'PLAIN-RAN',
    },
    'probe-plugin',
  );
  return { reg, ran: () => ran };
}

const callCtx = (enabledGroups?: string[]) => ({
  sessionId: 'onebot:group:1',
  platform: 'onebot',
  userId: 'anon',
  ...(enabledGroups ? { enabledGroups } : {}),
});

describe('工具分组闸在执行面同样生效', () => {
  it('未暴露该分组时按名直调被拒，handler 不执行', async () => {
    const { reg, ran } = setup();
    expect(
      reg.getDefinitions({ groups: [] }).map(d => d.function.name),
      '列举面本就看不到',
    ).toEqual(['probe_plain']);

    const res = await reg.execute('probe_grouped', {}, callCtx([]) as never);
    expect(res.content, '不向闸外调用者确认该工具存在').toContain('未找到');
    expect(ran(), '执行面漏闸就是这条测试要挡的回归').toBe(false);
  });

  it('暴露了该分组就照常执行', async () => {
    const { reg, ran } = setup();
    const res = await reg.execute('probe_grouped', {}, callCtx(['system']) as never);
    expect(res.content).toContain('HANDLER-RAN');
    expect(ran()).toBe(true);
  });

  it("'*' 通配放开全部分组", async () => {
    const { reg, ran } = setup();
    await reg.execute('probe_grouped', {}, callCtx(['*']) as never);
    expect(ran()).toBe(true);
  });

  it('调用方不传 enabledGroups（mcp-server / workflow）时行为不变', async () => {
    const { reg, ran } = setup();
    await reg.execute('probe_grouped', {}, callCtx() as never);
    expect(ran(), '它们各自另有暴露面控制，不应被这道闸误伤').toBe(true);
  });

  it('无分组的通用工具不受分组闸影响', async () => {
    const { reg } = setup();
    const res = await reg.execute('probe_plain', {}, callCtx([]) as never);
    expect(res.content).toContain('PLAIN-RAN');
  });

  it('近似名建议不把闸外的工具名念给模型', async () => {
    const { reg } = setup();
    const res = await reg.execute('probe_group', {}, callCtx([]) as never);
    expect(res.content).toContain('未找到');
    expect(res.content, '闸外工具名不该经建议回流').not.toContain('probe_grouped');
  });
});

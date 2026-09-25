import type { Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { ExecutionGuardContext } from '../../packages/api-authority/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';

// ════════════════════════════════════════════════════════════
// 没有执行守卫（未装 plugin-authority）时 tools / commands 两处同一口径 fail-closed：
// 等同人人都是默认等级、没有确认通道。曾经整段跳过校验——restricted、声明 confirm、
// 高 risk 的能力零鉴权直接执行。
//   - 需要更高等级（restricted / risk 非 safe，risk 遮蔽 visibility）→ 拒绝并点名缺权限插件
//   - 声明了 confirm → 拒绝（没人能确认）
//   - 默认等级可用且无需确认 → 照常执行
// 注入守卫后一切交给守卫裁决，放行即执行。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;

type Policy = Pick<RegisteredTool, 'visibility' | 'confirm' | 'risk'>;

/** 被拒（守卫缺席）的情形：name → 声明 */
const DENIED: Record<string, Policy> = {
  restricted: { visibility: 'restricted' },
  sensitive: { risk: 'sensitive' },
  dangerous: { risk: 'dangerous' },
  // risk 遮蔽 visibility：显式 public 也挡不住 sensitive 的等级要求
  'sensitive-public': { risk: 'sensitive', visibility: 'public' },
  'confirm-only': { confirm: 'session' },
  'safe-confirm': { risk: 'safe', confirm: 'always' },
};
/** 照常执行的情形 */
const ALLOWED: Record<string, Policy> = {
  plain: {},
  public: { visibility: 'public' },
  safe: { risk: 'safe' },
};

function toolRegistry(): { registry: ToolRegistry; ran: string[] } {
  const registry = new ToolRegistry(silent);
  const ran: string[] = [];
  for (const [name, policy] of Object.entries({ ...DENIED, ...ALLOWED })) {
    registry.register(
      {
        ...policy,
        definition: {
          type: 'function',
          function: { name, description: name, parameters: { type: 'object', properties: {} } },
        },
        handler: async () => {
          ran.push(name);
          return 'ok';
        },
      },
      'test',
    );
  }
  return { registry, ran };
}

function commandRegistry(): { registry: CommandRegistry; ran: string[] } {
  const registry = new CommandRegistry(silent);
  const ran: string[] = [];
  for (const [name, policy] of Object.entries({ ...DENIED, ...ALLOWED })) {
    registry.command(name, name, policy).action(async () => {
      ran.push(name);
      return 'ok';
    });
  }
  return { registry, ran };
}

const cmdInput = { sessionId: 's', platform: 'test', userId: 'u', args: [], raw: '' };

describe('tools：没有守卫时 fail-closed', () => {
  it('需要更高等级或需要确认的工具被拒，提示缺权限插件；handler 不执行', async () => {
    const { registry, ran } = toolRegistry();
    for (const name of Object.keys(DENIED)) {
      const out = await registry.execute(name, {}, { sessionId: 's' });
      expect(JSON.parse(out.content).error, name).toContain('@aalis/plugin-authority');
    }
    expect(ran).toEqual([]);
  });

  it('默认等级可用且无需确认的工具照常执行', async () => {
    const { registry, ran } = toolRegistry();
    for (const name of Object.keys(ALLOWED)) {
      expect((await registry.execute(name, {}, { sessionId: 's' })).content, name).toBe('ok');
    }
    expect(ran).toEqual(Object.keys(ALLOWED));
  });

  it('注入守卫后由守卫裁决：放行即执行，每次调用都过守卫', async () => {
    const { registry, ran } = toolRegistry();
    const seen: ExecutionGuardContext[] = [];
    registry.setExecutionGuard(async ctx => {
      seen.push(ctx);
      return null;
    });
    for (const name of Object.keys(DENIED)) {
      expect((await registry.execute(name, {}, { sessionId: 's' })).content, name).toBe('ok');
    }
    expect(ran).toEqual(Object.keys(DENIED));
    expect(seen.map(c => c.name)).toEqual(Object.keys(DENIED));
  });
});

describe('commands：没有守卫时 fail-closed（与 tools 同口径）', () => {
  it('需要更高等级或需要确认的指令被拒，提示缺权限插件；handler 不执行', async () => {
    const { registry, ran } = commandRegistry();
    for (const name of Object.keys(DENIED)) {
      expect(await registry.execute(name, cmdInput), name).toContain('@aalis/plugin-authority');
    }
    expect(ran).toEqual([]);
  });

  it('默认等级可用且无需确认的指令照常执行', async () => {
    const { registry, ran } = commandRegistry();
    for (const name of Object.keys(ALLOWED)) {
      expect(await registry.execute(name, cmdInput), name).toBe('ok');
    }
    expect(ran).toEqual(Object.keys(ALLOWED));
  });

  it('restricted 父分组下的子指令按整条路径取严：同样被拒', async () => {
    const registry = new CommandRegistry(silent);
    let ran = false;
    registry.command('admin', '管理', { visibility: 'restricted' });
    registry.command('admin.ping', 'ping').action(async () => {
      ran = true;
      return 'pong';
    });
    expect(await registry.execute('admin', { ...cmdInput, args: ['ping'] })).toContain('@aalis/plugin-authority');
    expect(ran).toBe(false);
  });

  it('注入守卫后由守卫裁决：放行即执行', async () => {
    const { registry, ran } = commandRegistry();
    registry.setExecutionGuard(async () => null);
    for (const name of Object.keys(DENIED)) {
      expect(await registry.execute(name, cmdInput), name).toBe('ok');
    }
    expect(ran).toEqual(Object.keys(DENIED));
  });
});

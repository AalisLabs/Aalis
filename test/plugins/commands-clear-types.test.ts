import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthorityService, authority } from '../../packages/api-authority/src/index.js';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import type { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import drawPlugin from '../../packages/plugin-draw/src/index.js';
import hooksPlugin from '../../packages/plugin-hooks/src/index.js';
import { provideEvents, registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /clear 的类型由处理它的插件经贡献点 memory:clear-type 登记：-t 的可选项、帮助里的说明与「不认识的类型」都按登记表现取，
// 第三方类型选得中，同一类型几家登记只列一次、显示名取收集次序里第一家的。贡献点插件不在时只认 all。
// 只读的 `/clear list` 已删掉，老习惯敲它时 list 落成多余参数，在确认之前报错。
// 显式指定的类型登记了却没有一行标注它（处理它的插件这次没出结果）时照实说明。
// ════════════════════════════════════════════════════════════

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** 登记清理类型的插件；handles 为真时另挂中间件处理它们，各行标 type */
function probe(name: string, types: Array<{ id: string; label: string }>, handles = false) {
  return definePlugin({
    name,
    uses: { hooks, contributions },
    apply({ hooks, contributions }) {
      for (const type of types) contributions.use.contribute('memory:clear-type', type);
      if (!handles) return;
      hooks.use.middleware('memory:clear', async (data, next) => {
        for (const { id } of types)
          if (!data.types || data.types.includes(id))
            data.results.push({ source: name, type: id, success: true, message: `${id} 已清` });
        await next();
      });
    },
  });
}

/**
 * 装 plugin-commands 与只有 clear/clearAll 的记忆替身，不装存储；noContributions 时只装钩子插件、不装贡献点插件；draw 时
 * 另装绘图（附件的写入方之一）
 */
async function world(opts: { probes?: ReturnType<typeof probe>[]; noContributions?: boolean; draw?: boolean } = {}) {
  const app = new App({ logLevel: 'error' });
  cleanups.push(() => app.stop());
  if (opts.noContributions) {
    provideEvents(app);
    await app.plugin(hooksPlugin);
    await app.plugins.idle();
  } else {
    await registerHubs(app);
  }
  const host = app.bind({ provide, commands: commandsService });
  const clearSession = vi.fn(async (_sessionId: string) => {});
  host.provide.use(memory, { clearSession, clearAll: async () => {} } as unknown as MemoryService);
  host.provide.use(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  // /help 按权限服务列出调用者能用的指令；这里测的是类型说明，给一个放行的替身
  host.provide.use(authority, { authorize: () => null } as unknown as AuthorityService);
  for (const definition of opts.probes ?? []) await app.plugin(definition);
  if (opts.draw) await app.plugin(drawPlugin, {});
  await app.plugin(commandsPlugin, {});
  await app.plugins.idle();
  const registry = host.commands.use as unknown as CommandRegistry;
  expect(registry.get('clear'), '内置指令随 plugin-commands 激活登记，idle() 之后已在').toBeDefined();
  const guardCalls: string[] = [];
  registry.setExecutionGuard(async ctx => {
    guardCalls.push(ctx.name);
    return { ok: true };
  });
  /** 按用户输入执行（经解析与守卫），私聊会话 */
  const exec = async (line: string): Promise<string> => {
    const parsed = registry.parseCommand(line);
    if (!parsed) throw new Error(`不是指令: ${line}`);
    const out = await registry.execute(parsed.name, {
      sessionId: 's-cur',
      platform: 'webui',
      userId: 'u1',
      sessionType: 'private',
      args: parsed.args,
      raw: parsed.raw,
    });
    return String(out);
  };
  /** /help clear 里 --type 下面列出的取值 */
  const typeLines = async () => (await exec('/help clear')).split('\n').filter(line => line.startsWith('  - '));
  return { registry, exec, typeLines, guardCalls, clearSession };
}

const NO_HANDLER = '没有已启用的插件处理这一类型';

describe('/clear 的类型由各插件登记', () => {
  it('第三方插件登记并处理 foo：/clear -t foo 执行，/help clear 列出 foo', async () => {
    const { exec, typeLines } = await world({ probes: [probe('zz-foo', [{ id: 'foo', label: '探针数据' }], true)] });
    expect(await typeLines()).toEqual([
      '  - all：全部类型',
      '  - context：消息历史与会话上下文（含摘要与待办）',
      '  - foo：探针数据',
    ]);
    expect(await exec('/clear -t foo')).toBe('foo 已清');
  });

  it('不认识的类型（含删掉的别名 history）：回不认识并列出现有类型，不清理', async () => {
    const { exec, clearSession } = await world({ probes: [probe('zz-foo', [{ id: 'foo', label: '探针数据' }], true)] });
    expect(await exec('/clear -t history')).toBe(
      '未知清理类型：history。可用类型：all, context, foo。说明见 /help clear',
    );
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('同一类型几家登记：帮助只列一次，显示名取收集次序里第一家的', async () => {
    const { exec, typeLines } = await world({
      probes: ['c', 'a', 'b'].map(n => probe(`zz-${n}`, [{ id: 'shared', label: `${n.toUpperCase()} 的说法` }])),
    });
    expect((await typeLines()).filter(line => line.startsWith('  - shared'))).toEqual(['  - shared：A 的说法']);
    expect(await exec('/clear -t shared')).toBe(`A 的说法：${NO_HANDLER}，未清理`);
  });

  it('贡献点插件不在：-t 只认 all，/clear -t context 回不认识；/clear 照常清', async () => {
    const { exec, typeLines, clearSession } = await world({ noContributions: true });
    expect(await typeLines()).toEqual(['  - all：全部类型']);
    expect(await exec('/clear -t context')).toBe('未知清理类型：context。可用类型：all。说明见 /help clear');
    expect(clearSession).not.toHaveBeenCalled();
    expect(await exec('/clear')).toBe('当前会话消息历史已清空');
    expect(clearSession).toHaveBeenCalledWith('s-cur');
  });
});

describe('/clear 的类型说明', () => {
  it('不再注册 clear.list', async () => {
    const { registry } = await world();
    expect(registry.getAll().map(c => c.name)).not.toContain('clear.list');
  });

  it('老习惯敲 /clear list、选项值用空格写多了：报未知子指令或多余参数并指向 /help clear，不进确认、不清理', async () => {
    const { exec, guardCalls, clearSession } = await world();
    expect(await exec('/clear list')).toBe('未知子指令或多余参数：list。输入 /help clear 查看用法。');
    // -t 只取下一个词，第二个 context 落成多余参数
    expect(await exec('/clear -t context context')).toBe('未知子指令或多余参数：context。输入 /help clear 查看用法。');
    expect(guardCalls).toEqual([]);
    expect(clearSession).not.toHaveBeenCalled();
  });
});

describe('/clear 显式指定的类型没有处理者', () => {
  const unhandled = () => probe('zz-kind', [{ id: 'zz-kind', label: '探针类型' }]);

  it('登记了却没有一行标注它：与消息历史一起指定时照常清消息历史，另说明它未清理（会话级与全局）', async () => {
    const { exec } = await world({ probes: [unhandled()] });
    const note = `探针类型：${NO_HANDLER}，未清理`;
    expect(await exec('/clear -t zz-kind -t context')).toBe(['当前会话消息历史已清空', note].join('\n'));
    expect(await exec('/clear all -t zz-kind -t context')).toBe(['所有消息历史和归档已清空', note].join('\n'));
  });

  it('存储不在：附件的写入方（绘图）不出失败行，/clear 只清消息历史，-t image 照实说明未清理', async () => {
    const { exec } = await world({ draw: true });
    expect(await exec('/clear')).toBe('当前会话消息历史已清空');
    expect(await exec('/clear -t image')).toBe(`图片缓存：${NO_HANDLER}，未清理`);
  });

  it('不指定类型的 /clear 与 /clear all 不追加任何说明', async () => {
    const { exec } = await world({ probes: [unhandled()] });
    expect(await exec('/clear')).toBe('当前会话消息历史已清空');
    expect(await exec('/clear all')).toBe('所有消息历史和归档已清空');
  });
});

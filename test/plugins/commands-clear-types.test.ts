import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BoundCommands, commands as commandsService } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import type { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import commandsPlugin, { CLEAR_TYPES } from '../../packages/plugin-commands/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /clear 的类型说明与回执：
// - 只读的 `/clear list` 沿点路径继承了 /clear 的确认，列个类型也要真人点确认。已删掉，类型说明并进
//   --type 选项（/help clear 可见）。老习惯敲 `/clear list` 时 list 落成 /clear 的多余参数，
//   必须在确认之前报「未知子指令或多余参数」并指向 /help clear，不能进入清理确认。
// - 显式指定的类型没有插件处理（插件未装或未激活）时，回执曾只字不提；单独 -t vector 回
//   「无可清除的记忆模块」。现在逐个核对 memory:clear 结果行上的 type，没有就照实说明。
// ════════════════════════════════════════════════════════════

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/**
 * 装 plugin-commands 与只有 clear/clearAll 的记忆替身；附件缓存放在临时目录的 data 根下，
 * noDataRoot 时不注册存储根（附件清理走失败行）；vectorHandler 时另装一个标注 vector 的清理中间件
 */
async function world(opts: { vectorHandler?: boolean; noDataRoot?: boolean } = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, commands: commandsService });
  if (!opts.noDataRoot) {
    const base = mkdtempSync(join(tmpdir(), 'aalis-clear-types-'));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    await app.plugin(storageLocal, {
      roots: [
        {
          name: 'data',
          path: join(base, 'data'),
          kind: 'data',
          browsable: false,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
  }
  const clearSession = vi.fn(async (_sessionId: string) => {});
  host.provide(memory, { clearSession, clearAll: async () => {} } as unknown as MemoryService);
  host.provide(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  if (opts.vectorHandler) {
    await app.plugin(
      definePlugin({
        name: 'vector-probe',
        uses: { hooks },
        apply({ hooks }) {
          hooks.middleware('memory:clear', async (data, next) => {
            if (!data.types || data.types.includes('vector'))
              data.results.push({ source: 'vector-probe', type: 'vector', success: true, message: '向量已清' });
            await next();
          });
        },
      }),
    );
  }
  await app.plugin(commandsPlugin, {});
  await app.plugins.idle();
  const registry = (host.commands as BoundCommands).current as unknown as CommandRegistry;
  const guardCalls: string[] = [];
  registry.setExecutionGuard(async ctx => {
    guardCalls.push(ctx.name);
    return null;
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
  return { registry, exec, guardCalls, clearSession };
}

const NO_HANDLER = '没有已启用的插件处理这一类型';

describe('/clear 的类型说明', () => {
  it('不再注册 clear.list；/help clear 列出每个类型的取值与中文说明', async () => {
    const { registry, exec } = await world();
    expect(registry.getAll().map(c => c.name)).not.toContain('clear.list');
    const help = await exec('/help clear');
    for (const t of CLEAR_TYPES) {
      expect(help).toContain(`${t.id}：${t.label}`);
    }
  });

  it('老习惯敲 /clear list、选项值用空格写多了：报未知子指令或多余参数并指向 /help clear，不进确认、不清理', async () => {
    const { exec, guardCalls, clearSession } = await world();
    expect(await exec('/clear list')).toBe('未知子指令或多余参数: list。输入 /help clear 查看用法。');
    // -t 只取下一个词，vector 落成多余参数
    expect(await exec('/clear -t context vector')).toBe('未知子指令或多余参数: vector。输入 /help clear 查看用法。');
    expect(guardCalls).toEqual([]);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('未知清理类型的提示指向 /help clear', async () => {
    const { exec, clearSession } = await world();
    const out = await exec('/clear -t bogus');
    expect(out.startsWith('未知清理类型: bogus')).toBe(true);
    expect(out.endsWith('说明见 /help clear')).toBe(true);
    expect(clearSession).not.toHaveBeenCalled();
  });
});

describe('/clear 显式指定的类型没有处理者', () => {
  it('没有插件处理 vector：与图片一起指定时照常清图片，另说明向量未清理（会话级与全局）', async () => {
    const { exec } = await world();
    const vectorNote = `⚠ 向量记忆：${NO_HANDLER}，未清理`;
    expect(await exec('/clear -t vector -t image')).toBe(['✅ 当前会话无图片缓存', vectorNote].join('\n'));
    expect(await exec('/clear all -t vector -t image')).toBe(
      ['✅ 图片缓存目录不存在，无需清空', vectorNote].join('\n'),
    );
  });

  it('附件缓存清理失败：照实报失败，不另说明无处理者', async () => {
    const { exec } = await world({ noDataRoot: true });
    const out = await exec('/clear -t image');
    expect(out.startsWith('⚠ 图片缓存清空失败: ')).toBe(true);
    expect(out).not.toContain(NO_HANDLER);
  });

  it('单独 -t vector：回说明，而不是「无可清除的记忆模块」', async () => {
    const { exec } = await world();
    expect(await exec('/clear -t vector')).toBe(`⚠ 向量记忆：${NO_HANDLER}，未清理`);
  });

  it('有插件以 type 标注处理了 vector：不再说明', async () => {
    const { exec } = await world({ vectorHandler: true });
    expect(await exec('/clear -t vector')).toBe('✅ 向量已清');
  });

  it('会话级显式指定 user-profile / user-relation：说明只在 /clear all 时清理；全局且无处理者时说明无处理者', async () => {
    const { exec } = await world();
    expect(await exec('/clear -t user-profile,user-relation')).toBe(
      [
        '⚠ 用户档案与第三方行为指令只在 /clear all 时清理，本次未清理',
        '⚠ 用户关系图谱只在 /clear all 时清理，本次未清理',
      ].join('\n'),
    );
    expect(await exec('/clear all -t user-relation')).toBe(`⚠ 用户关系图谱：${NO_HANDLER}，未清理`);
  });

  it('不指定类型的 /clear 与 /clear all 不追加任何说明', async () => {
    const { exec } = await world();
    for (const line of ['/clear', '/clear all']) {
      const out = await exec(line);
      expect(out, line).not.toContain(NO_HANDLER);
      expect(out, line).not.toContain('只在 /clear all 时清理');
    }
  });
});

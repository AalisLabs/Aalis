import { App, definePlugin, type Logger, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { capabilityMinLevel } from '../../packages/api-authority/src/index.js';
import { type BoundCommands, commands } from '../../packages/api-commands/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { ref } from '../fixtures/service-ref.js';

// 简易 logger（仅 child + 几个等级，足以驱动 CommandRegistry）
function makeLogger(warns?: string[]): Logger {
  const noop = () => undefined;
  const l: Logger = {
    debug: noop,
    info: noop,
    warn: warns ? (message: string) => void warns.push(message) : noop,
    error: noop,
    child: () => l,
  } as unknown as Logger;
  return l;
}

function input(args: string[]) {
  return { sessionId: 's', platform: 'test', args, raw: args.join(' ') };
}

/**
 * 指令随激活撤回：宿主提供注册表，插件经 `commands` 门面登记，卸载走 `plugins.unload`。
 * 门面把声明挂在这次激活的 id 上，撤回时只摘自己那一层。
 */
async function withCmdApp(
  run: (api: {
    r: CommandRegistry;
    load: (id: string, register: (bound: BoundCommands) => void) => Promise<void>;
    unload: (id: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const app = new App({ logLevel: 'error' });
  const r = new CommandRegistry(makeLogger(), ref(), ref());
  app.bind({ provide }).provide.use(commands, r);
  const load = async (id: string, register: (bound: BoundCommands) => void): Promise<void> => {
    await app.plugin(
      definePlugin({
        name: id,
        uses: { commands },
        apply({ commands: bound }) {
          register(bound.use);
        },
      }),
    );
    await app.plugins.idle();
    const state = app.plugins.getPlugin(id)?.state;
    if (state !== 'active') throw new Error(`插件 "${id}" 未激活（state=${state}）`);
  };
  const unload = async (id: string): Promise<void> => {
    await app.plugins.unload(id);
    await app.plugins.idle();
  };
  try {
    await run({ r, load, unload });
  } finally {
    await app.stop();
  }
}

describe('commands v2 — 链式 builder', () => {
  it('注册顶层命令并执行', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('hello', '打招呼').action(async () => 'hi');
    expect(r.has('hello')).toBe(true);
    expect(await r.execute('hello', input([]))).toBe('hi');
  });

  it('内联 DSL 解析位置参数（required / optional / text）', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('echo <a:string> [b:text]', '回声').action(
      async (_argv, a, b) => `${a as string}|${(b as string) ?? ''}`,
    );
    expect(await r.execute('echo', input(['foo']))).toBe('foo|');
    expect(await r.execute('echo', input(['foo', 'bar', 'baz']))).toBe('foo|bar baz');
    // 缺少必填位置参数
    expect(await r.execute('echo', input([]))).toMatch(/缺少必填参数/);
  });

  it('option 三种语法：boolean flag / 必带值 / 可选值', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('demo', '示例')
      .option('verbose', '-v', { description: 'flag' })
      .option('page', '-p <page:number>', { description: '页码' })
      .option('greedy', '-g [name:string]', { description: '可选值' })
      .action(async argv => JSON.stringify(argv.options));
    expect(await r.execute('demo', input(['-v']))).toBe(JSON.stringify({ verbose: true }));
    expect(await r.execute('demo', input(['-p', '3']))).toBe(JSON.stringify({ page: 3 }));
    expect(await r.execute('demo', input(['--page=5']))).toBe(JSON.stringify({ page: 5 }));
    expect(await r.execute('demo', input(['-g']))).toBe(JSON.stringify({ greedy: true }));
    expect(await r.execute('demo', input(['-g', 'alice']))).toBe(JSON.stringify({ greedy: 'alice' }));
  });

  it('number 选项/参数收到非数字 → 清晰报错（旧实现静默传 NaN 给 handler）', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('demo', '示例')
      .option('page', '-p <page:number>', { description: '页码' })
      .action(async argv => JSON.stringify(argv.options));
    expect(await r.execute('demo', input(['-p', 'abc']))).toMatch(/需要数字/);
    expect(await r.execute('demo', input(['--page=x1']))).toMatch(/需要数字/);
    // 合法数字仍正常
    expect(await r.execute('demo', input(['-p', '7']))).toBe(JSON.stringify({ page: 7 }));

    const r2 = new CommandRegistry(makeLogger(), ref(), ref());
    r2.command('seek <n:number>', '跳转').action(async (_argv, n) => `n=${n}`);
    expect(await r2.execute('seek', input(['notnum']))).toMatch(/需要数字/);
    expect(await r2.execute('seek', input(['42']))).toBe('n=42');
  });

  it('string[] 选项可重复追加', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('tag', '标签')
      .option('type', '-t <type:string[]>')
      .action(async argv => JSON.stringify(argv.options.type));
    expect(await r.execute('tag', input(['-t', 'a', '-t', 'b,c']))).toBe(JSON.stringify(['a', 'b', 'c']));
  });

  it('dot-path 子命令最长前缀解析 + 自动分组', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    // 测的是解析而非鉴权：放行守卫代替 plugin-authority（没有守卫时 restricted 指令一律被拒）
    r.setExecutionGuard(async () => ({ ok: true }));
    r.command('profile.clear', '清除自己档案').action(async () => 'cleared');
    r.command('profile.clear.nuke', '清空所有', { visibility: 'restricted' }).action(async () => 'nuked');
    // profile 自动成为分组节点
    const profile = r.get('profile')!;
    expect(profile.isGroup).toBe(true);
    expect(profile.handler).toBeUndefined();

    expect(await r.execute('profile', input(['clear']))).toBe('cleared');
    expect(await r.execute('profile', input(['clear', 'nuke']))).toBe('nuked');
  });

  it('有子指令、自身不收位置参数的指令收到多余的词：不执行，按当前前缀指向 /help 下该指令的完整路径', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    const ran: string[] = [];
    r.command('profile.clear', '清除自己档案').action(async () => {
      ran.push('clear');
      return 'cleared';
    });
    r.command('profile.clear.nuke', '清空所有').action(async () => 'nuked');
    expect(await r.execute('profile', input(['clear', 'nuk']))).toBe(
      '未知子指令或多余参数：nuk。输入 /help profile clear 查看用法。',
    );
    r.prefix = '#';
    expect(await r.execute('profile', input(['clear', 'me']))).toBe(
      '未知子指令或多余参数：me。输入 #help profile clear 查看用法。',
    );
    expect(ran).toEqual([]);
  });

  it('visibility 声明 + 继承到子节点（restricted 父 → restricted 子）', () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('a.b', '', { visibility: 'restricted' }).action(async () => 'b');
    r.command('a.b.c', '').action(async () => 'c');
    const b = r.get('a.b')!;
    const c = r.get('a.b.c')!;
    expect(b.visibility).toBe('restricted');
    expect(c.visibility).toBe('restricted'); // 继承自父
    // 默认无声明 → public
    r.command('x', '').action(async () => 'x');
    expect(r.get('x')!.visibility).toBe('public');
  });

  it('risk 透传 + 沿点路径继承 + 进 guard ctx（authority 据此派生最低等级：sensitive 1、dangerous 2）', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('sys.exec', '', { risk: 'dangerous' }).action(async () => 'x');
    r.command('sys.exec.bg', '').action(async () => 'y'); // 未声明 → 继承父 risk
    expect(r.get('sys.exec')!.risk).toBe('dangerous');
    expect(r.get('sys.exec.bg')!.risk).toBe('dangerous'); // 继承
    r.command('note.clear', '', { risk: 'sensitive' }).action(async () => 'z');
    expect(r.getAll().find(c => c.name === 'note.clear')!.risk).toBe('sensitive');
    // 无声明 → undefined（不臆造默认，让 authority 回退 visibility 兜底）
    r.command('plain', '').action(async () => 'p');
    expect(r.get('plain')!.risk).toBeUndefined();
    // 原始 risk 流入 guard ctx（不被折成 visibility）
    let seen: unknown = 'unset';
    r.setExecutionGuard(async ctx => {
      seen = ctx.risk;
      return { ok: true };
    });
    await r.execute('sys', input(['exec']));
    expect(seen).toBe('dangerous');
  });

  it('guard 拒绝 → execute 返回拒绝原因', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('shutdown', '关机', { visibility: 'restricted' }).action(async () => 'bye');
    r.setExecutionGuard(async () => ({ ok: false, reason: '权限不足' }));
    expect(await r.execute('shutdown', input([]))).toBe('权限不足');
  });

  it('未注册命令返回未知指令提示', async () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    expect(await r.execute('nope', input([]))).toMatch(/未知指令/);
  });

  it('命令名段校验：非法段抛错', () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    expect(() => r.command('Bad', '')).toThrow();
    expect(() => r.command('a.B', '')).toThrow();
    expect(() => r.command('1leading', '')).toThrow();
  });

  it('parseCommand 仅识别带前缀输入', () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('hi', '').action(async () => 'hello');
    expect(r.parseCommand('/hi a b')).toEqual({ name: 'hi', args: ['a', 'b'], raw: '/hi a b' });
    expect(r.parseCommand('hi a b')).toBeNull();
    expect(r.parseCommand('  ')).toBeNull();
  });

  it('parseCommand：引号里的整段是一个参数，空的引号是一个空参数', () => {
    const r = new CommandRegistry(makeLogger(), ref(), ref());
    r.command('hi', '').action(async () => 'hello');
    expect(r.parseCommand(`/hi "a b" '' "" c`)?.args).toEqual(['a b', '', '', 'c']);
  });
});

// ════════════════════════════════════════════════════════════
// 同名指令：节点是**声明栈**，不是单值格子
//
// 旧实现每个名字只有一层，同名再注册就地清空并改写 pluginName。两条后果都实测过：
//   A 注册 shutdown(restricted) → restricted
//   B 同名重注册（不带 meta）    → public        ← 任何插件都能把权限闸降掉
//   B 卸载                       → 整个节点消失   ← A 的指令一并没了且不会回来
// ════════════════════════════════════════════════════════════

describe('同名指令（声明栈）', () => {
  const reg = () => new CommandRegistry(makeLogger(), ref(), ref());
  const find = (r: CommandRegistry, n: string) => r.getAll().find(c => c.name === n);

  it.each([
    ['A', 'B'],
    ['B', 'A'],
  ])('位次靠前的生效：栈顶不看登记的先后，告警点名生效的与被压住的（先 %s 后 %s）', async (first, second) => {
    const warns: string[] = [];
    const r = new CommandRegistry(makeLogger(warns), ref(), ref());
    for (const who of [first, second]) {
      r.command('ping', `${who} 的`, { pluginName: who }).action(async () => `from-${who}`);
    }
    expect(await r.execute('ping', input([]))).toBe('from-A');
    expect(find(r, 'ping')?.description).toBe('A 的');
    expect(warns).toEqual(['指令 /ping 重名：A 的声明生效，B 的声明被压住（生效的卸载后顶上；权限取各层里最严的）']);
  });

  it('同一位次的两层：后登记的生效', async () => {
    const r = reg();
    r.command('ping', '第一次', { pluginName: 'A' }).action(async () => 'first');
    r.command('ping', '第二次', { pluginName: 'A' }).action(async () => 'second');
    expect(await r.execute('ping', input([]))).toBe('second');
  });

  it('没给位次的按 pluginName 排，给了的按位次：宿主的根（空串）最靠前', async () => {
    const r = reg();
    r.command('ping', 'A 的', { pluginName: 'A' }).action(async () => 'from-A');
    r.command('ping', '根的', { pluginName: 'root', seat: '' }).action(async () => 'from-root');
    expect(await r.execute('ping', input([]))).toBe('from-root');
  });

  it('生效的那层卸载后，被压住的声明**自动复位**', async () => {
    await withCmdApp(async ({ r, load, unload }) => {
      await load('A', bound => void bound.command('ping', 'A 的').action(async () => 'from-A'));
      await load('B', bound => void bound.command('ping', 'B 的').action(async () => 'from-B'));
      await unload('A');
      expect(find(r, 'ping'), '节点不该整个消失').toBeDefined();
      expect(await r.execute('ping', input([]))).toBe('from-B');
      expect(find(r, 'ping')?.pluginName).toBe('B');
    });
  });

  it('被压住的那层卸载：只摘自己那层，生效的照常工作', async () => {
    await withCmdApp(async ({ r, load, unload }) => {
      await load('A', bound => void bound.command('ping', 'A 的').action(async () => 'from-A'));
      await load('B', bound => void bound.command('ping', 'B 的').action(async () => 'from-B'));
      await unload('B');
      expect(await r.execute('ping', input([]))).toBe('from-A');
      expect(find(r, 'ping')?.pluginName).toBe('A');
    });
  });

  it('全部卸载后节点才消失', async () => {
    await withCmdApp(async ({ r, load, unload }) => {
      await load('A', bound => void bound.command('ping', 'A').action(async () => 'a'));
      await load('B', bound => void bound.command('ping', 'B').action(async () => 'b'));
      await unload('A');
      await unload('B');
      expect(find(r, 'ping')).toBeUndefined();
    });
  });

  // ⚠️ 断言必须落在**门槛等级**上，不能只看 visibility 那一栏。
  // 曾经这组用例只断言 `visibility === 'restricted'`，而攻击载荷 `{risk:'safe'}` 能让它继续
  // 通过、同时把 minLevel 从 2 打到 0 —— 测试钉的是实现细节，不是要守的性质。
  const minLevelOf = (r: CommandRegistry, name: string) => {
    const c = r.getAll().find(x => x.name === name);
    return capabilityMinLevel({ risk: c?.risk, visibility: c?.visibility });
  };

  it('**提权闸**：后注册者压 risk 也放宽不了门槛（risk 会遮蔽 visibility）', () => {
    const r = reg();
    r.command('shutdown', '关机', { visibility: 'restricted', pluginName: 'A' }).action(async () => 'a');
    expect(minLevelOf(r, 'shutdown'), '基线门槛').toBe(2);
    // 真实攻击载荷：只声明 risk:'safe'。裁决函数里 risk 完全遮蔽 visibility，
    // 逐轴合并会把它当成「risk 轴上唯一的声明」而采纳，门槛掉到 0。
    r.command('shutdown', '我的关机', { risk: 'safe', pluginName: 'EVIL' }).action(async () => 'PWNED');
    expect(minLevelOf(r, 'shutdown'), '压 risk:safe 之后门槛不能降').toBe(2);
  });

  it('**提权闸**：显式 public 也放宽不了继承来的 restricted', () => {
    const r = reg();
    r.command('admin', '管理', { visibility: 'restricted', pluginName: 'A' }).action(async () => 'a');
    r.command('admin.kill', '杀', { pluginName: 'A' }).action(async () => 'k');
    expect(minLevelOf(r, 'admin.kill'), '从父分组继承 restricted').toBe(2);
    r.command('admin.kill', '我的杀', { visibility: 'public', pluginName: 'EVIL' }).action(async () => 'PWNED');
    expect(minLevelOf(r, 'admin.kill'), '子节点显式 public 不能打穿父继承').toBe(2);
  });

  it('**提权闸**：继承来的 dangerous 不能被后来者的 safe 盖掉', () => {
    const r = reg();
    r.command('sys', '系统', { risk: 'dangerous', pluginName: 'A' }).action(async () => 'a');
    r.command('sys.exec', '执行', { pluginName: 'A' }).action(async () => 'e');
    expect(minLevelOf(r, 'sys.exec')).toBe(2);
    r.command('sys.exec', '我的执行', { risk: 'safe', pluginName: 'EVIL' }).action(async () => 'PWNED');
    expect(minLevelOf(r, 'sys.exec'), '继承来的 dangerous 不能被 safe 盖掉').toBe(2);
  });

  it('**提权闸**：不带 meta 与显式 public 两种重注册都放宽不了', () => {
    const r = reg();
    r.command('shutdown', '关机', { visibility: 'restricted', pluginName: 'A' }).action(async () => 'a');
    r.command('shutdown', '我的关机', { pluginName: 'B' }).action(async () => 'b');
    expect(minLevelOf(r, 'shutdown')).toBe(2);
    r.command('shutdown', '再来', { visibility: 'public', pluginName: 'C' }).action(async () => 'c');
    expect(minLevelOf(r, 'shutdown')).toBe(2);
  });

  it('**提权闸**：祖先链上任意一层都放宽不了叶子的门槛', () => {
    // 上一版只把「本节点 vs 继承值」取了严，祖先之间仍是逐级覆盖——在中间插一层就打穿。
    const r = reg();
    r.command('admin', '管理', { visibility: 'restricted', pluginName: 'A' }).action(async () => 'a');
    r.command('admin.sys.shutdown', '关机', { pluginName: 'A' }).action(async () => 'ok');
    expect(minLevelOf(r, 'admin.sys.shutdown'), '从最上层继承 restricted').toBe(2);

    r.command('admin.sys', '子组', { risk: 'safe', pluginName: 'EVIL' }).action(async () => 'x');
    expect(minLevelOf(r, 'admin.sys.shutdown'), '中间层压 risk:safe 不能打穿').toBe(2);

    r.command('admin.sys', '再来', { visibility: 'public', pluginName: 'EVIL2' }).action(async () => 'y');
    expect(minLevelOf(r, 'admin.sys.shutdown'), '中间层写 public 同样不能').toBe(2);
  });

  it('**提权闸**：深祖先的 public 打不穿浅祖先的 restricted', () => {
    const r = reg();
    r.command('a', '', { visibility: 'restricted', pluginName: 'A' }).action(async () => '1');
    r.command('a.b.c', '', { pluginName: 'A' }).action(async () => '2');
    r.command('a.b', '', { visibility: 'public', pluginName: 'EVIL' }).action(async () => 'x');
    expect(minLevelOf(r, 'a.b.c')).toBe(2);
  });

  it('链上任意一层收紧都生效（单向仍成立）', () => {
    const r = reg();
    r.command('x.y.z', '', { pluginName: 'A' }).action(async () => '1');
    expect(minLevelOf(r, 'x.y.z')).toBe(0);
    r.command('x.y', '', { risk: 'dangerous', pluginName: 'B' }).action(async () => '2');
    expect(minLevelOf(r, 'x.y.z'), '中间层收紧要向下生效').toBe(2);
  });

  it('后来者仍可**收紧**（单向）', () => {
    const r = reg();
    r.command('foo', 'A', { pluginName: 'A' }).action(async () => 'a');
    expect(minLevelOf(r, 'foo')).toBe(0);
    r.command('foo', 'B', { visibility: 'restricted', risk: 'dangerous', pluginName: 'B' }).action(async () => 'b');
    expect(minLevelOf(r, 'foo')).toBe(2);
  });

  it('收紧方卸载后，门槛退回剩余声明的最严值', async () => {
    await withCmdApp(async ({ r, load, unload }) => {
      await load('A', bound => void bound.command('foo', 'A').action(async () => 'a'));
      await load('B', bound => void bound.command('foo', 'B', { visibility: 'restricted' }).action(async () => 'b'));
      expect(minLevelOf(r, 'foo')).toBe(2);
      await unload('B');
      expect(minLevelOf(r, 'foo')).toBe(0);
    });
  });

  // ⚠️ 上面整组只钉了**门槛等级**这一轴。confirm 是 authority 的独立轴 B，曾经一条断言都没有，
  // 于是「安全轴整份取最严」上线后把 confirm 随定级败者一起丢掉，1174 个用例无一报警。
  const confirmOf = (r: CommandRegistry, name: string) => r.getAll().find(x => x.name === name)?.confirm;

  it('**确认闸**：祖先与叶子定级平局时，叶子的 confirm 不能被丢掉', () => {
    // 真实形态：plugin-user-profile 的 `profile.clear`(restricted) 与
    // `profile.clear.nuke`(dangerous) 同为等级 2，平局取先入者=祖先，叶子的
    // confirm='session'（由 risk:'dangerous' 推导）随之消失 → 清空所有用户档案不再二次确认。
    const r = reg();
    r.command('profile.clear', '清自己的', { visibility: 'restricted', pluginName: 'A' }).action(async () => 'a');
    r.command('profile.clear.nuke', '【危险】清所有', { risk: 'dangerous', pluginName: 'A' }).action(async () => 'n');
    expect(minLevelOf(r, 'profile.clear.nuke'), '门槛仍是 2').toBe(2);
    expect(confirmOf(r, 'profile.clear.nuke'), 'dangerous 推导出的确认闸必须保留').toBe('session');
  });

  it('**确认闸**：后注册者放宽不了 —— 压一层高等级声明抹不掉既有 confirm', () => {
    // {visibility:'restricted'} 等级 2 会压过 {confirm:'always'} 的等级 0；
    // 若 confirm 跟着定级赢家走，等于任何插件重注册一次就能摘掉别人的确认闸。
    const r = reg();
    r.command('wipe', 'A', { confirm: 'always', pluginName: 'A' }).action(async () => 'a');
    r.command('wipe', 'EVIL', { visibility: 'restricted', pluginName: 'EVIL' }).action(async () => 'x');
    expect(confirmOf(r, 'wipe'), '既有的 always 不能被抹掉').toBe('always');
  });

  it('**确认闸**：后注册者仍可收紧（单向），且卸载后退回剩余声明的最严值', async () => {
    await withCmdApp(async ({ r, load, unload }) => {
      await load('A', bound => void bound.command('foo', 'A').action(async () => 'a'));
      expect(confirmOf(r, 'foo')).toBeUndefined();
      await load('B', bound => void bound.command('foo', 'B', { confirm: 'session' }).action(async () => 'b'));
      expect(confirmOf(r, 'foo'), '收紧要生效').toBe('session');
      await load('C', bound => void bound.command('foo', 'C', { confirm: 'always' }).action(async () => 'c'));
      expect(confirmOf(r, 'foo'), 'always 比 session 更严').toBe('always');
      await unload('C');
      expect(confirmOf(r, 'foo'), '最严者卸载后退回次严').toBe('session');
    });
  });

  it('**确认闸**：祖先声明的 confirm 沿 dot path 向下生效', () => {
    const r = reg();
    r.command('sys', '', { confirm: 'always', pluginName: 'A' }).action(async () => 'a');
    r.command('sys.exec', '', { pluginName: 'A' }).action(async () => 'e');
    expect(confirmOf(r, 'sys.exec')).toBe('always');
  });

  it('unregister 带插件名只摘一层；不带则摘全部（管理面）', async () => {
    const r = reg();
    r.command('ping', 'A', { pluginName: 'A' }).action(async () => 'a');
    r.command('ping', 'B', { pluginName: 'B' }).action(async () => 'b');
    r.unregister('ping', 'B');
    expect(await r.execute('ping', input([]))).toBe('a');
    r.unregister('ping');
    expect(find(r, 'ping')).toBeUndefined();
  });

  it('分组节点：子指令还在时父节点退回分组而非消失', () => {
    const r = reg();
    r.command('grp', '分组本体', { pluginName: 'A' }).action(async () => 'a');
    r.command('grp.child', '子', { pluginName: 'A' }).action(async () => 'c');
    r.unregister('grp', 'A');
    const grp = find(r, 'grp');
    expect(grp, '子指令还在，父节点该退回自动分组').toBeDefined();
    expect(grp?.isGroup).toBe(true);
    expect(toSource(grp?.description)).toBe('grp 命令组');
  });
});

describe('分组节点回收', () => {
  it('插件卸载后不留幽灵分组——`/relation` 不该继续被指令相位吞掉', async () => {
    // 分组节点由 ensureGroups 自动创建（空栈、无 pluginName），任何按激活 id 的摘除都匹配
    // 不到它们。漏掉回收会让指令相位继续吞掉 `/relation`。
    await withCmdApp(async ({ r, load, unload }) => {
      await load('P', bound => {
        bound.command('relation.show', '看').action(async () => 's');
        bound.command('relation.cleanup.all', '清').action(async () => 'c');
      });
      await unload('P');
      expect(
        r.getAll().map(c => c.name),
        '两级分组都该被回收',
      ).toEqual([]);
      expect(r.hasMatch('relation', []), '不再吞掉 /relation').toBe(false);
    });
  });

  it('还有子指令时分组节点保留', async () => {
    await withCmdApp(async ({ r, load, unload }) => {
      await load('P', bound => void bound.command('grp.a', 'A').action(async () => 'a'));
      await load('Q', bound => void bound.command('grp.b', 'B').action(async () => 'b'));
      await unload('P');
      expect(
        r
          .getAll()
          .map(c => c.name)
          .sort(),
      ).toEqual(['grp', 'grp.b']);
    });
  });

  it('被显式声明过的分组节点，卸载后同样回收（不留空壳）', async () => {
    await withCmdApp(async ({ r, load, unload }) => {
      await load('P', bound => {
        bound.command('grp', '分组本体').action(async () => 'g');
        bound.command('grp.sub', '子').action(async () => 's');
      });
      await unload('P');
      expect(r.getAll().map(c => c.name)).toEqual([]);
    });
  });
});

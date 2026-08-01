import type { Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { capabilityMinLevel } from '../../packages/api-authority/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';

// 简易 logger（仅 child + 几个等级，足以驱动 CommandRegistry）
function makeLogger(): Logger {
  const noop = () => undefined;
  const l: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => l,
  } as unknown as Logger;
  return l;
}

function input(args: string[]) {
  return { sessionId: 's', platform: 'test', args, raw: args.join(' ') };
}

describe('commands v2 — 链式 builder', () => {
  it('注册顶层命令并执行', async () => {
    const r = new CommandRegistry(makeLogger());
    r.command('hello', '打招呼').action(async () => 'hi');
    expect(r.has('hello')).toBe(true);
    expect(await r.execute('hello', input([]))).toBe('hi');
  });

  it('内联 DSL 解析位置参数（required / optional / text）', async () => {
    const r = new CommandRegistry(makeLogger());
    r.command('echo <a:string> [b:text]', '回声').action(
      async (_argv, a, b) => `${a as string}|${(b as string) ?? ''}`,
    );
    expect(await r.execute('echo', input(['foo']))).toBe('foo|');
    expect(await r.execute('echo', input(['foo', 'bar', 'baz']))).toBe('foo|bar baz');
    // 缺少必填位置参数
    expect(await r.execute('echo', input([]))).toMatch(/缺少必填参数/);
  });

  it('option 三种语法：boolean flag / 必带值 / 可选值', async () => {
    const r = new CommandRegistry(makeLogger());
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
    const r = new CommandRegistry(makeLogger());
    r.command('demo', '示例')
      .option('page', '-p <page:number>', { description: '页码' })
      .action(async argv => JSON.stringify(argv.options));
    expect(await r.execute('demo', input(['-p', 'abc']))).toMatch(/需要数字/);
    expect(await r.execute('demo', input(['--page=x1']))).toMatch(/需要数字/);
    // 合法数字仍正常
    expect(await r.execute('demo', input(['-p', '7']))).toBe(JSON.stringify({ page: 7 }));

    const r2 = new CommandRegistry(makeLogger());
    r2.command('seek <n:number>', '跳转').action(async (_argv, n) => `n=${n}`);
    expect(await r2.execute('seek', input(['notnum']))).toMatch(/需要数字/);
    expect(await r2.execute('seek', input(['42']))).toBe('n=42');
  });

  it('string[] 选项可重复追加', async () => {
    const r = new CommandRegistry(makeLogger());
    r.command('tag', '标签')
      .option('type', '-t <type:string[]>')
      .action(async argv => JSON.stringify(argv.options.type));
    expect(await r.execute('tag', input(['-t', 'a', '-t', 'b,c']))).toBe(JSON.stringify(['a', 'b', 'c']));
  });

  it('dot-path 子命令最长前缀解析 + 自动分组', async () => {
    const r = new CommandRegistry(makeLogger());
    r.command('profile.clear', '清除自己档案').action(async () => 'cleared');
    r.command('profile.clear.nuke', '清空所有', { visibility: 'restricted' }).action(async () => 'nuked');
    // profile 自动成为分组节点
    const profile = r.get('profile')!;
    expect(profile.isGroup).toBe(true);
    expect(profile.handler).toBeUndefined();

    expect(await r.execute('profile', input(['clear']))).toBe('cleared');
    expect(await r.execute('profile', input(['clear', 'nuke']))).toBe('nuked');
  });

  it('visibility 声明 + 继承到子节点（restricted 父 → restricted 子）', () => {
    const r = new CommandRegistry(makeLogger());
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

  it('risk 透传 + 沿点路径继承 + 进 guard ctx（authority 据此派生 minTier：sensitive→朋友/dangerous→信任）', async () => {
    const r = new CommandRegistry(makeLogger());
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
      return null;
    });
    await r.execute('sys', input(['exec']));
    expect(seen).toBe('dangerous');
  });

  it('guard 拒绝 → execute 返回拒绝原因', async () => {
    const r = new CommandRegistry(makeLogger());
    r.command('shutdown', '关机', { visibility: 'restricted' }).action(async () => 'bye');
    r.setExecutionGuard(async () => '权限不足');
    expect(await r.execute('shutdown', input([]))).toBe('权限不足');
  });

  it('未注册命令返回未知指令提示', async () => {
    const r = new CommandRegistry(makeLogger());
    expect(await r.execute('nope', input([]))).toMatch(/未知指令/);
  });

  it('命令名段校验：非法段抛错', () => {
    const r = new CommandRegistry(makeLogger());
    expect(() => r.command('Bad', '')).toThrow();
    expect(() => r.command('a.B', '')).toThrow();
    expect(() => r.command('1leading', '')).toThrow();
  });

  it('parseCommand 仅识别带前缀输入', () => {
    const r = new CommandRegistry(makeLogger());
    r.command('hi', '').action(async () => 'hello');
    expect(r.parseCommand('/hi a b')).toEqual({ name: 'hi', args: ['a', 'b'], raw: '/hi a b' });
    expect(r.parseCommand('hi a b')).toBeNull();
    expect(r.parseCommand('  ')).toBeNull();
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
  const reg = () => new CommandRegistry(makeLogger());
  const find = (r: CommandRegistry, n: string) => r.getAll().find(c => c.name === n);

  it('后来者胜：栈顶决定跑谁的实现（与旧行为一致）', async () => {
    const r = reg();
    r.command('ping', 'A 的', { pluginName: 'A' }).action(async () => 'from-A');
    r.command('ping', 'B 的', { pluginName: 'B' }).action(async () => 'from-B');
    expect(await r.execute('ping', input([]))).toBe('from-B');
    expect(find(r, 'ping')?.description).toBe('B 的');
  });

  it('覆盖者卸载后，被覆盖的声明**自动复位**', async () => {
    const r = reg();
    r.command('ping', 'A 的', { pluginName: 'A' }).action(async () => 'from-A');
    r.command('ping', 'B 的', { pluginName: 'B' }).action(async () => 'from-B');
    r.unregisterByPlugin('B');
    expect(find(r, 'ping'), '节点不该整个消失').toBeDefined();
    expect(await r.execute('ping', input([]))).toBe('from-A');
    expect(find(r, 'ping')?.pluginName).toBe('A');
  });

  it('先注册者卸载：只摘自己那层，覆盖者照常工作', async () => {
    const r = reg();
    r.command('ping', 'A 的', { pluginName: 'A' }).action(async () => 'from-A');
    r.command('ping', 'B 的', { pluginName: 'B' }).action(async () => 'from-B');
    r.unregisterByPlugin('A');
    expect(await r.execute('ping', input([]))).toBe('from-B');
  });

  it('全部卸载后节点才消失', () => {
    const r = reg();
    r.command('ping', 'A', { pluginName: 'A' }).action(async () => 'a');
    r.command('ping', 'B', { pluginName: 'B' }).action(async () => 'b');
    r.unregisterByPlugin('A');
    r.unregisterByPlugin('B');
    expect(find(r, 'ping')).toBeUndefined();
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

  it('收紧方卸载后，门槛退回剩余声明的最严值', () => {
    const r = reg();
    r.command('foo', 'A', { pluginName: 'A' }).action(async () => 'a');
    r.command('foo', 'B', { visibility: 'restricted', pluginName: 'B' }).action(async () => 'b');
    expect(minLevelOf(r, 'foo')).toBe(2);
    r.unregisterByPlugin('B');
    expect(minLevelOf(r, 'foo')).toBe(0);
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

  it('别名撞名：抢占者卸载后，先注册者的别名要复位而不是被连坐删除', async () => {
    // 与「覆盖者卸载把整个节点连根删掉」同一个病，只是从指令节点挪到了别名表。
    const r = reg();
    r.command('ping', 'A', { pluginName: 'A' })
      .alias('p')
      .action(async () => 'a');
    r.command('other', 'B', { pluginName: 'B' })
      .alias('p')
      .action(async () => 'b');
    expect(await r.execute('p', input([])), '抢占期间指向 B').toBe('b');
    r.unregisterByPlugin('B');
    expect(r.hasMatch('p', []), '别名不该被连坐删除').toBe(true);
    expect(await r.execute('p', input([])), '应复位到仍声明它的 A').toBe('a');
  });

  it('同名指令栈内的别名：栈顶卸载后退回下层声明的别名', async () => {
    const r = reg();
    r.command('ping', 'A', { pluginName: 'A' })
      .alias('pa')
      .action(async () => 'a');
    r.command('ping', 'B', { pluginName: 'B' })
      .alias('pb')
      .action(async () => 'b');
    r.unregisterByPlugin('B');
    expect(r.hasMatch('pb', []), 'B 自己的别名该消失').toBe(false);
    expect(await r.execute('pa', input([])), 'A 的别名仍可用且指向 A').toBe('a');
  });

  it('无人再声明的别名要真的删掉（不能只重绑）', async () => {
    const r = reg();
    r.command('ping', 'A', { pluginName: 'A' })
      .alias('solo')
      .action(async () => 'a');
    r.unregisterByPlugin('A');
    expect(r.hasMatch('solo', [])).toBe(false);
  });

  it('别名随其所属声明一起回收，不误删他人的', async () => {
    const r = reg();
    r.command('ping', 'A', { pluginName: 'A' })
      .alias('pa')
      .action(async () => 'a');
    r.command('other', 'B', { pluginName: 'B' })
      .alias('pb')
      .action(async () => 'b');
    r.unregisterByPlugin('A');
    expect(await r.execute('pb', input([])), '别人的别名不该被误删').toBe('b');
    expect(r.hasMatch('pa', []), '自己的别名随声明一起回收').toBe(false);
  });

  it('分组节点：子指令还在时父节点退回分组而非消失', () => {
    const r = reg();
    r.command('grp', '分组本体', { pluginName: 'A' }).action(async () => 'a');
    r.command('grp.child', '子', { pluginName: 'A' }).action(async () => 'c');
    r.unregister('grp', 'A');
    const grp = find(r, 'grp');
    expect(grp, '子指令还在，父节点该退回自动分组').toBeDefined();
    expect(grp?.isGroup).toBe(true);
    expect(grp?.description).toBe('grp 命令组');
  });
});

describe('分组节点回收', () => {
  const reg = () => new CommandRegistry(makeLogger());

  it('插件卸载后不留幽灵分组——`/relation` 不该继续被指令相位吞掉', async () => {
    // 分组节点由 ensureGroups 自动创建（空栈、无 pluginName），任何按插件名的摘除都匹配
    // 不到它们。旧实现与声明栈实现都漏，是既有缺陷而非重构引入。
    const r = reg();
    r.command('relation.show', '看', { pluginName: 'P' }).action(async () => 's');
    r.command('relation.cleanup.all', '清', { pluginName: 'P' }).action(async () => 'c');
    r.unregisterByPlugin('P');
    expect(
      r.getAll().map(c => c.name),
      '两级分组都该被回收',
    ).toEqual([]);
    expect(r.hasMatch('relation', []), '不再吞掉 /relation').toBe(false);
  });

  it('还有子指令时分组节点保留', async () => {
    const r = reg();
    r.command('grp.a', 'A', { pluginName: 'P' }).action(async () => 'a');
    r.command('grp.b', 'B', { pluginName: 'Q' }).action(async () => 'b');
    r.unregisterByPlugin('P');
    expect(
      r
        .getAll()
        .map(c => c.name)
        .sort(),
    ).toEqual(['grp', 'grp.b']);
  });

  it('被显式声明过的分组节点，卸载后同样回收（不留空壳）', async () => {
    const r = reg();
    r.command('grp', '分组本体', { pluginName: 'P' }).action(async () => 'g');
    r.command('grp.sub', '子', { pluginName: 'P' }).action(async () => 's');
    r.unregisterByPlugin('P');
    expect(r.getAll().map(c => c.name)).toEqual([]);
  });
});

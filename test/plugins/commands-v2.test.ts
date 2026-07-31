import type { Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
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

  it('**提权闸**：后注册者放宽不了已有的 restricted', () => {
    const r = reg();
    r.command('shutdown', '关机', { visibility: 'restricted', pluginName: 'A' }).action(async () => 'a');
    expect(find(r, 'shutdown')?.visibility).toBe('restricted');
    // 不带 meta 的重注册：旧实现会把它降成 public
    r.command('shutdown', '我的关机', { pluginName: 'B' }).action(async () => 'b');
    expect(find(r, 'shutdown')?.visibility, '安全轴取全栈最严').toBe('restricted');
    // 显式写 public 也放宽不了
    r.command('shutdown', '再来', { visibility: 'public', pluginName: 'C' }).action(async () => 'c');
    expect(find(r, 'shutdown')?.visibility).toBe('restricted');
  });

  it('后来者可以**收紧**（只单向）', () => {
    const r = reg();
    r.command('foo', 'A', { pluginName: 'A' }).action(async () => 'a');
    expect(find(r, 'foo')?.visibility).toBe('public');
    r.command('foo', 'B', { visibility: 'restricted', risk: 'dangerous', pluginName: 'B' }).action(async () => 'b');
    expect(find(r, 'foo')?.visibility).toBe('restricted');
    expect(find(r, 'foo')?.risk).toBe('dangerous');
  });

  it('收紧方卸载后，安全轴退回剩余声明的最严值', () => {
    const r = reg();
    r.command('foo', 'A', { pluginName: 'A' }).action(async () => 'a');
    r.command('foo', 'B', { visibility: 'restricted', pluginName: 'B' }).action(async () => 'b');
    r.unregisterByPlugin('B');
    expect(find(r, 'foo')?.visibility).toBe('public');
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

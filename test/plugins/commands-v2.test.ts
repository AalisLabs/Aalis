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

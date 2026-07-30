import { describe, expect, it } from 'vitest';
import {
  buildRespawnCommand,
  envKeysOwnedByFile,
  isRestartRollback,
  parseDotenvKeys,
  parseEnvFileArgs,
} from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime — 重启命令组装
//
// 设防的是一条真实缺陷：重生若只沿用 process.argv，会丢掉 process.execArgv 里的
// node 层 flag（脚手架启动脚本的 --env-file-if-exists=.env、用户自加的
// --max-old-space-size），症状是「改完 .env 再重启永远不生效」。
// ════════════════════════════════════════════════════════════

describe('buildRespawnCommand（重生命令组装）', () => {
  it('node 入口：execArgv 插在脚本路径之前，用户参数原序保留', () => {
    const { exec, args } = buildRespawnCommand(
      ['/usr/bin/node', '/app/dist/start.js', '--config', 'aalis.yaml'],
      ['--env-file-if-exists=.env', '--max-old-space-size=4096'],
    );
    expect(exec).toBe('/usr/bin/node');
    expect(args).toEqual([
      '--env-file-if-exists=.env',
      '--max-old-space-size=4096',
      '/app/dist/start.js',
      '--config',
      'aalis.yaml',
    ]);
  });

  it('node 入口：execArgv 为空时等价于旧行为（argv 去掉可执行文件）', () => {
    const { exec, args } = buildRespawnCommand(['/usr/bin/node', '/app/dist/start.js'], []);
    expect(exec).toBe('/usr/bin/node');
    expect(args).toEqual(['/app/dist/start.js']);
  });

  it('.ts 入口：走 tsx，且**不**透传 execArgv（tsx 是包装脚本，node flag 由它自己转交，前置会重复注册）', () => {
    const { exec, args } = buildRespawnCommand(
      ['/usr/bin/node', '/app/src/start.ts', '--dev'],
      ['--import', 'tsx/esm'],
      '/nonexistent-cwd', // 本地无 tsx 二进制 → 回落到 PATH 上的 tsx
    );
    expect(exec).toBe('tsx');
    expect(args).toEqual(['/app/src/start.ts', '--dev']);
  });

  it('argv 缺可执行文件时回落到 process.execPath，不产出 undefined 命令', () => {
    const { exec } = buildRespawnCommand([], []);
    expect(exec).toBe(process.execPath);
  });

  it('不改写入参数组（调用方的 process.argv / execArgv 不被污染）', () => {
    const argv = ['/usr/bin/node', '/app/dist/start.js'];
    const execArgv = ['--enable-source-maps'];
    buildRespawnCommand(argv, execArgv);
    expect(argv).toEqual(['/usr/bin/node', '/app/dist/start.js']);
    expect(execArgv).toEqual(['--enable-source-maps']);
  });
});

// ════════════════════════════════════════════════════════════
// env 文件重载
//
// 单保留 execArgv **不足以**让「改完 .env 再重启」生效：Node 的 --env-file 不覆盖
// 环境里已存在的键，而子进程继承父进程解析后的 process.env，于是那些键已经"存在"，
// 新值永远写不进去（已在 node v22.16.0 实测）。必须把「值确实来自 env 文件」的键
// 从子进程环境里剔掉。
// ════════════════════════════════════════════════════════════

describe('parseEnvFileArgs（从 execArgv 找 env 文件）', () => {
  it('认 = 形式与空格形式，两种 flag 名都收', () => {
    expect(parseEnvFileArgs(['--env-file=.env'])).toEqual(['.env']);
    expect(parseEnvFileArgs(['--env-file-if-exists=.env.local'])).toEqual(['.env.local']);
    expect(parseEnvFileArgs(['--env-file', '.env'])).toEqual(['.env']);
    expect(parseEnvFileArgs(['--env-file-if-exists', 'a.env', '--env-file=b.env'])).toEqual(['a.env', 'b.env']);
  });

  it('忽略无关 flag，且空格形式缺参数时不吞后续', () => {
    expect(parseEnvFileArgs(['--max-old-space-size=4096', '--enable-source-maps'])).toEqual([]);
    expect(parseEnvFileArgs(['--env-file'])).toEqual([]); // 末尾无值，不该产出 undefined
  });
});

describe('parseDotenvKeys', () => {
  it('解析 KEY=VALUE，容忍 export 前缀与引号包裹', () => {
    const m = parseDotenvKeys('FOO=bar\nexport BAZ=qux\nQUOTED="has space"\nSINGLE=\'x\'\n');
    expect(m.get('FOO')).toBe('bar');
    expect(m.get('BAZ')).toBe('qux');
    expect(m.get('QUOTED')).toBe('has space');
    expect(m.get('SINGLE')).toBe('x');
  });

  it('跳过注释、空行与非法行', () => {
    const m = parseDotenvKeys('# comment\n\n  \nnot-a-pair\n1BAD=x\nOK=1\n');
    expect([...m.keys()]).toEqual(['OK']);
  });
});

describe('envKeysOwnedByFile（哪些键的值确实来自 env 文件）', () => {
  const read = (files: Record<string, string>) => (p: string) => files[p];

  it('值与文件一致 → 判为文件所有（重启时应剔除，好让新值写进来）', () => {
    const owned = envKeysOwnedByFile(['--env-file-if-exists=.env'], { FOO: 'old' }, read({ '.env': 'FOO=old\n' }));
    expect([...owned]).toEqual(['FOO']);
  });

  it('shell 显式覆盖过（值与文件不一致）→ 不算文件所有，重启后仍由 shell 赢', () => {
    // 这条守的是「修复不得改变优先级语义」：Node 让 shell 赢，重启后也必须让 shell 赢。
    const owned = envKeysOwnedByFile(
      ['--env-file-if-exists=.env'],
      { FOO: 'from-shell' },
      read({ '.env': 'FOO=from-file\n' }),
    );
    expect(owned.size).toBe(0);
  });

  it('文件读不到（--env-file-if-exists 指向不存在的文件）→ 空集，不抛', () => {
    expect(envKeysOwnedByFile(['--env-file-if-exists=.env'], { FOO: 'x' }, () => undefined).size).toBe(0);
  });

  it('未使用 env 文件 → 空集（此时子进程直接继承 process.env，零开销）', () => {
    expect(envKeysOwnedByFile(['--enable-source-maps'], { FOO: 'x' }, read({})).size).toBe(0);
  });

  it('多个 env 文件累加', () => {
    const owned = envKeysOwnedByFile(
      ['--env-file=a.env', '--env-file=b.env'],
      { A: '1', B: '2' },
      read({ 'a.env': 'A=1\n', 'b.env': 'B=2\n' }),
    );
    expect([...owned].sort()).toEqual(['A', 'B']);
  });
});

describe('isRestartRollback（core 透传的不透明凭据在本层校验）', () => {
  it('结构合格才认', () => {
    expect(isRestartRollback({ reason: 'x', restore: [] })).toBe(true);
    expect(isRestartRollback({ reason: 'x', restore: [{ path: '/a', content: 'c' }] })).toBe(true);
  });

  it('缺字段 / 类型不对 / 空值一律拒绝（拒绝即走「无凭据」分支，不做半吊子回滚）', () => {
    expect(isRestartRollback(undefined)).toBe(false);
    expect(isRestartRollback(null)).toBe(false);
    expect(isRestartRollback({})).toBe(false);
    expect(isRestartRollback({ reason: 'x' })).toBe(false);
    expect(isRestartRollback({ restore: [] })).toBe(false);
    expect(isRestartRollback({ reason: 1, restore: [] })).toBe(false);
    expect(isRestartRollback({ reason: 'x', restore: 'nope' })).toBe(false);
  });
});

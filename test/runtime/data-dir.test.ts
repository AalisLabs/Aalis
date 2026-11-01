import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  assertAbsolute,
  derivePaths,
  HostArgsError,
  initDataDir,
  isDataDirInitialized,
  isFullyAbsolute,
  parseHostArgs,
  resolveDataDir,
} from '../../packages/runtime/src/data-dir.js';
import { setupFileLogger } from '../../packages/runtime/src/file-logger.js';
import { createNodeModulesPluginLoader } from '../../packages/runtime/src/node-modules-loader.js';
import { createFsPluginLoader, createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime — 数据目录的解析、派生与初始化
//
// 覆盖顺序：--data → AALIS_DATA → 部署目录（安装集）下的 data/，给了 --profile / AALIS_PROFILE 时是 data-<名>/。
// 不在用户主目录下放缺省的数据目录。profile 名既拼进目录也拼进数据库名，格式要挡住跳出部署目录的写法；profile 与
// --data、AALIS_DATA 同时给出时报错，不静默挑一个（以为进了测试实例、实际写进主实例）。
// ════════════════════════════════════════════════════════════

const base = { env: {}, cwd: '/work', userHome: '/u', appDir: '/app' };

describe('parseHostArgs', () => {
  it('取走开头的宿主参数，余下的原样留给子命令', () => {
    expect(parseHostArgs(['--data', 'h', '--profile=p', '--init', '--service', 'probe', '--data', 'x'])).toEqual({
      data: 'h',
      profile: 'p',
      init: true,
      service: true,
      rest: ['probe', '--data', 'x'],
    });
  });

  it('开头的 `--` 跳过（pnpm 会原样传进来）', () => {
    expect(parseHostArgs(['--data', 'h', '--', '--init'])).toEqual({ data: 'h', init: true, service: false, rest: [] });
    expect(parseHostArgs(['--', 'probe', 'a'])).toEqual({ init: false, service: false, rest: ['probe', 'a'] });
  });

  it('没有宿主参数时全部是子命令；空 argv 是守护进程', () => {
    expect(parseHostArgs(['probe'])).toEqual({ init: false, service: false, rest: ['probe'] });
    expect(parseHostArgs([])).toEqual({ init: false, service: false, rest: [] });
  });

  it.each([[['--data']], [['--data=']], [['--profile']]])('缺取值报错：%j', argv => {
    expect(() => parseHostArgs(argv)).toThrow(HostArgsError);
  });

  it.each([
    [['--root', '/x', '--init']],
    [['--dat=/x', 'status']],
    [['--init', '--verbose']],
  ])('开头那一段里不认识的 -- 参数报错，不当成子命令落到缺省的数据目录上：%j', argv => {
    expect(() => parseHostArgs(argv)).toThrow(HostArgsError);
    expect(() => parseHostArgs(argv)).toThrow(/^Unknown host option --\w+.*--data, --profile, --init, --service/);
  });

  it('子命令之后的 -- 参数归子命令，宿主不管', () => {
    expect(parseHostArgs(['probe', '--root', 'x'])).toEqual({
      init: false,
      service: false,
      rest: ['probe', '--root', 'x'],
    });
  });
});

describe('resolveDataDir', () => {
  it('覆盖顺序：--data 压过 AALIS_DATA，AALIS_DATA 压过部署目录下的 data/', () => {
    const env = { AALIS_DATA: '/env-data' };
    expect(resolveDataDir({ ...base, env, args: { data: '/arg-data' } })).toEqual({ dir: '/arg-data' });
    expect(resolveDataDir({ ...base, env, args: {} })).toEqual({ dir: '/env-data' });
    expect(resolveDataDir({ ...base, args: {} })).toEqual({ dir: '/app/data' });
  });

  it('命令行与环境变量里的相对路径按启动时的 cwd 解析', () => {
    expect(resolveDataDir({ ...base, args: { data: 'h' } })).toEqual({ dir: '/work/h' });
    expect(resolveDataDir({ ...base, env: { AALIS_DATA: 'h' }, args: {} })).toEqual({ dir: '/work/h' });
  });

  it('profile 得到部署目录下的 data-<名>/', () => {
    expect(resolveDataDir({ ...base, args: { profile: 'test-1' } })).toEqual({
      dir: '/app/data-test-1',
      profile: 'test-1',
    });
    expect(resolveDataDir({ ...base, env: { AALIS_PROFILE: 'p' }, args: {} })).toEqual({
      dir: '/app/data-p',
      profile: 'p',
    });
  });

  it('命令行的 --profile 压过环境变量 AALIS_PROFILE', () => {
    expect(resolveDataDir({ ...base, env: { AALIS_PROFILE: 'env' }, args: { profile: 'arg' } }).profile).toBe('arg');
  });

  it.each([
    [{ data: '/h', profile: 'p' }, {}, '--data and --profile'],
    [{ profile: 'p' }, { AALIS_DATA: '/h' }, 'AALIS_DATA and --profile'],
    [{ data: '/h' }, { AALIS_PROFILE: 'p' }, '--data and AALIS_PROFILE'],
    [{}, { AALIS_DATA: '/h', AALIS_PROFILE: 'p' }, 'AALIS_DATA and AALIS_PROFILE'],
  ])('profile 与 --data、AALIS_DATA 同时给出时报错：%j %j', (args, env, named) => {
    expect(() => resolveDataDir({ ...base, args, env })).toThrow(`Both ${named} are set`);
  });

  it.each(['../x', 'a/b', 'Test', '-x', '', 'a'.repeat(33), 'a.b', 'a_b'])('拒绝不合法的 profile 名：%j', profile => {
    expect(() => resolveDataDir({ ...base, args: { profile } })).toThrow(HostArgsError);
  });

  it.each(['a', '0', 'test-1', 'a'.repeat(32)])('接受合法的 profile 名：%j', profile => {
    expect(resolveDataDir({ ...base, args: { profile } }).dir).toBe(`/app/data-${profile}`);
  });

  it('部署目录必须是绝对路径：不按 cwd 猜，别的来源胜出时也照样报', () => {
    expect(() => resolveDataDir({ ...base, appDir: 'rel', args: {} })).toThrow(HostArgsError);
    expect(() => resolveDataDir({ ...base, appDir: 'rel', env: { AALIS_DATA: '/h' }, args: {} })).toThrow(
      'appDir must be an absolute path',
    );
  });

  it('环境变量设成空串视同没设', () => {
    expect(resolveDataDir({ ...base, env: { AALIS_DATA: '', AALIS_PROFILE: '' }, args: {} })).toEqual({
      dir: '/app/data',
    });
    expect(resolveDataDir({ ...base, env: { AALIS_DATA: '/h', AALIS_PROFILE: '' }, args: {} })).toEqual({ dir: '/h' });
    expect(resolveDataDir({ ...base, env: { AALIS_DATA: '', AALIS_PROFILE: 'p' }, args: {} })).toEqual({
      dir: '/app/data-p',
      profile: 'p',
    });
  });

  it('经 --data 或 AALIS_DATA 选中的数据目录不带 profile：目录名像 data-<名> 或旧的 ~/.aalis-<名> 也一样', () => {
    expect(resolveDataDir({ ...base, args: { data: '/app/data-test' } })).toEqual({ dir: '/app/data-test' });
    expect(resolveDataDir({ ...base, env: { AALIS_DATA: '~/.aalis-test' }, args: {} })).toEqual({
      dir: '/u/.aalis-test',
    });
  });

  it('开头的 ~ 展开成用户主目录；「~用户名」写法报错', () => {
    expect(resolveDataDir({ ...base, args: { data: '~/x' } })).toEqual({ dir: '/u/x' });
    expect(resolveDataDir({ ...base, env: { AALIS_DATA: '~' }, args: {} })).toEqual({ dir: '/u' });
    expect(() => resolveDataDir({ ...base, args: { data: '~bob/x' } })).toThrow('"~user" paths are not supported');
  });

  it('启动目录已不存在（cwd 取不到）时，绝对路径照常可用，相对路径报错', () => {
    const noCwd = { env: {}, userHome: '/u', appDir: '/app' };
    expect(resolveDataDir({ ...noCwd, args: { data: '/abs/h' } })).toEqual({ dir: '/abs/h' });
    expect(resolveDataDir({ ...noCwd, args: {} })).toEqual({ dir: '/app/data' });
    expect(() => resolveDataDir({ ...noCwd, args: { data: 'rel' } })).toThrow('The current directory no longer exists');
  });
});

describe('isFullyAbsolute', () => {
  it('Windows 上要带盘符或 UNC 前缀：只以分隔符开头的路径按当前盘解析，仍依赖 cwd', () => {
    expect(isFullyAbsolute('C:\\aalis', 'win32')).toBe(true);
    expect(isFullyAbsolute('D:/aalis', 'win32')).toBe(true);
    expect(isFullyAbsolute('\\\\nas\\share', 'win32')).toBe(true);
    expect(isFullyAbsolute('\\aalis', 'win32')).toBe(false);
    expect(isFullyAbsolute('/aalis', 'win32')).toBe(false);
    expect(isFullyAbsolute('C:aalis', 'win32')).toBe(false);
  });

  it('assertAbsolute 拒收相对路径', () => {
    expect(() => assertAbsolute('Config file path', 'aalis.config.yaml')).toThrow(
      'Config file path must be an absolute path',
    );
    expect(() => assertAbsolute('Config file path', '/h/aalis.config.yaml')).not.toThrow();
  });

  it('宿主件的路径参数拒收相对路径，不按调用那一刻的 cwd 解析', async () => {
    expect(() => createFsYamlConfigProvider('aalis.config.yaml')).toThrow('Config file path must be an absolute path');
    expect(() => createFsPluginLoader('packages')).toThrow('Packages directory must be an absolute path');
    expect(() => createNodeModulesPluginLoader('.')).toThrow('Install directory must be an absolute path');
    await expect(setupFileLogger('logs/latest.log')).rejects.toThrow('Log file path must be an absolute path');
  });
});

describe('derivePaths', () => {
  it('布局全部挂在数据目录下，安装集单独给', () => {
    const p = derivePaths('/h', '/app', 'p');
    expect(p).toEqual({
      data: '/h',
      profile: 'p',
      app: '/app',
      config: '/h/aalis.config.yaml',
      secrets: '/h/secrets.yaml',
      state: '/h/state',
      logs: '/h/logs',
      cache: '/h/cache',
      run: '/h/run',
      tmp: '/h/tmp',
      self: '/h/self',
      workspace: '/h/workspace',
    });
    expect('profile' in derivePaths('/h', '/app')).toBe(false);
  });

  it('交给插件的路径对象是冻结的：一处改了不会带偏别的插件', () => {
    const p = derivePaths('/h', '/app');
    expect(Object.isFrozen(p)).toBe(true);
  });
});

describe('initDataDir', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'aalis-dataDir-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('建目录与两个文件，权限收紧；之后算已初始化', () => {
    const paths = derivePaths(join(tmp(), 'h'), '/app');
    expect(isDataDirInitialized(paths)).toBe(false);
    initDataDir(paths);
    expect(isDataDirInitialized(paths)).toBe(true);
    expect(statSync(paths.data).mode & 0o777).toBe(0o700);
    expect(statSync(paths.tmp).mode & 0o777).toBe(0o700);
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(statSync(paths.secrets).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.secrets, 'utf-8')).toBe('');
    expect(statSync(paths.workspace).isDirectory()).toBe(true);
    expect(statSync(paths.self).isDirectory()).toBe(true);
  });

  it('已存在的空目录沿用并收紧为 0700', () => {
    const dataDir = join(tmp(), 'h');
    mkdirSync(dataDir);
    // 显式放宽：umask 为 077 时 mkdir 建出来就是 0700，不放宽这条用例什么也测不到
    chmodSync(dataDir, 0o755);
    expect(statSync(dataDir).mode & 0o777).toBe(0o755);
    initDataDir(derivePaths(dataDir, '/app'));
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it('已初始化时拒绝，不碰现有文件', () => {
    const paths = derivePaths(tmp(), '/app');
    writeFileSync(paths.config, 'name: mine\n');
    writeFileSync(paths.secrets, 'k: v\n');
    expect(() => initDataDir(paths)).toThrow('already initialized');
    expect(readFileSync(paths.config, 'utf-8')).toBe('name: mine\n');
    expect(readFileSync(paths.secrets, 'utf-8')).toBe('k: v\n');
  });

  it('上次初始化中途失败（布局与 secrets.yaml 在、主配置没写）时可以重来：不清掉 secrets.yaml，并收紧它的权限', () => {
    const paths = derivePaths(tmp(), '/app');
    mkdirSync(paths.state);
    mkdirSync(paths.self);
    mkdirSync(paths.workspace);
    writeFileSync(paths.secrets, 'k: v\n');
    chmodSync(paths.secrets, 0o644);
    writeFileSync(join(paths.data, '.DS_Store'), '');
    initDataDir(paths);
    expect(isDataDirInitialized(paths)).toBe(true);
    expect(readFileSync(paths.secrets, 'utf-8')).toBe('k: v\n');
    expect(statSync(paths.secrets).mode & 0o777).toBe(0o600);
  });

  it('主配置只写名字、日志级别与空的插件段，不写平台档', () => {
    const paths = derivePaths(join(tmp(), 'h'), join(tmp(), 'app'));
    initDataDir(paths);
    expect(parseYaml(readFileSync(paths.config, 'utf-8'))).toEqual({ name: 'Aalis', logLevel: 'info', plugins: {} });
  });

  it('不读安装集的 package.json：它坏了也照常初始化', () => {
    const app = tmp();
    writeFileSync(join(app, 'package.json'), '{ not json');
    const paths = derivePaths(join(tmp(), 'h'), app);
    initDataDir(paths);
    expect(isDataDirInitialized(paths)).toBe(true);
  });

  it('目录里有布局以外的东西时拒绝：不把用户主目录或仓库改成 0700、再往里铺布局', () => {
    const dataDir = tmp();
    chmodSync(dataDir, 0o755);
    writeFileSync(join(dataDir, 'notes.txt'), 'x');
    mkdirSync(join(dataDir, 'src'));
    expect(() => initDataDir(derivePaths(dataDir, '/app'))).toThrow('not empty (it contains notes.txt, src)');
    expect(statSync(dataDir).mode & 0o777).toBe(0o755);
    expect(existsSync(join(dataDir, 'state'))).toBe(false);
    expect(existsSync(join(dataDir, 'secrets.yaml'))).toBe(false);
  });
});

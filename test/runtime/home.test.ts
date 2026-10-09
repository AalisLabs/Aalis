import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { setupFileLogger } from '../../packages/runtime/src/file-logger.js';
import {
  assertAbsolute,
  derivePaths,
  HomeArgsError,
  initHome,
  isFullyAbsolute,
  isHomeInitialized,
  parseHostArgs,
  profileOfRealHome,
  resolveHome,
} from '../../packages/runtime/src/home.js';
import { createNodeModulesPluginLoader } from '../../packages/runtime/src/node-modules-loader.js';
import { createFsPluginLoader, createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime — 家目录的解析、派生与初始化
//
// 覆盖顺序：--home → AALIS_HOME → --profile / AALIS_PROFILE → 宿主的 defaultHome → ~/.aalis。
// profile 名既拼进目录也拼进数据库名，格式要挡住跳出家目录的写法；profile 与更高优先级的来源同时给出时报错，
// 不静默挑一个（以为进了测试实例、实际写进主实例）。
// ════════════════════════════════════════════════════════════

const base = { env: {}, cwd: '/work', userHome: '/u' };

describe('parseHostArgs', () => {
  it('取走开头的宿主参数，余下的原样留给子命令', () => {
    expect(parseHostArgs(['--home', 'h', '--profile=p', '--init', '--service', 'probe', '--home', 'x'])).toEqual({
      home: 'h',
      profile: 'p',
      init: true,
      service: true,
      rest: ['probe', '--home', 'x'],
    });
  });

  it('开头的 `--` 跳过（pnpm 会原样传进来）', () => {
    expect(parseHostArgs(['--home', 'h', '--', '--init'])).toEqual({ home: 'h', init: true, service: false, rest: [] });
    expect(parseHostArgs(['--', 'probe', 'a'])).toEqual({ init: false, service: false, rest: ['probe', 'a'] });
  });

  it('没有宿主参数时全部是子命令；空 argv 是守护进程', () => {
    expect(parseHostArgs(['probe'])).toEqual({ init: false, service: false, rest: ['probe'] });
    expect(parseHostArgs([])).toEqual({ init: false, service: false, rest: [] });
  });

  it.each([[['--home']], [['--home=']], [['--profile']]])('缺取值报错：%j', argv => {
    expect(() => parseHostArgs(argv)).toThrow(HomeArgsError);
  });
});

describe('resolveHome', () => {
  it('覆盖顺序：--home 压过 AALIS_HOME，AALIS_HOME 压过 defaultHome，最后是 ~/.aalis', () => {
    const env = { AALIS_HOME: '/env-home' };
    expect(resolveHome({ ...base, env, args: { home: '/arg-home' }, defaultHome: '/d' })).toEqual({
      home: '/arg-home',
    });
    expect(resolveHome({ ...base, env, args: {}, defaultHome: '/d' })).toEqual({ home: '/env-home' });
    expect(resolveHome({ ...base, args: {}, defaultHome: '/d' })).toEqual({ home: '/d' });
    expect(resolveHome({ ...base, args: {} })).toEqual({ home: '/u/.aalis' });
  });

  it('命令行与环境变量里的相对路径按启动时的 cwd 解析', () => {
    expect(resolveHome({ ...base, args: { home: '.aalis-dev' } })).toEqual({ home: '/work/.aalis-dev' });
    expect(resolveHome({ ...base, env: { AALIS_HOME: 'h' }, args: {} })).toEqual({ home: '/work/h' });
  });

  it('profile 得到并列的 ~/.aalis-<名>，压过 defaultHome', () => {
    expect(resolveHome({ ...base, args: { profile: 'test-1' }, defaultHome: '/d' })).toEqual({
      home: '/u/.aalis-test-1',
      profile: 'test-1',
    });
    expect(resolveHome({ ...base, env: { AALIS_PROFILE: 'p' }, args: {} })).toEqual({
      home: '/u/.aalis-p',
      profile: 'p',
    });
  });

  it('命令行的 --profile 压过环境变量 AALIS_PROFILE', () => {
    expect(resolveHome({ ...base, env: { AALIS_PROFILE: 'env' }, args: { profile: 'arg' } }).profile).toBe('arg');
  });

  it.each([
    [{ home: '/h', profile: 'p' }, {}, '--home 与 --profile'],
    [{ profile: 'p' }, { AALIS_HOME: '/h' }, 'AALIS_HOME 与 --profile'],
    [{ home: '/h' }, { AALIS_PROFILE: 'p' }, '--home 与 AALIS_PROFILE'],
    [{}, { AALIS_HOME: '/h', AALIS_PROFILE: 'p' }, 'AALIS_HOME 与 AALIS_PROFILE'],
  ])('profile 与更高优先级的来源同时给出时报错：%j %j', (args, env, named) => {
    expect(() => resolveHome({ ...base, args, env })).toThrow(`同时指定了 ${named}`);
  });

  it.each(['../x', 'a/b', 'Test', '-x', '', 'a'.repeat(33), 'a.b', 'a_b'])('拒绝不合法的 profile 名：%j', profile => {
    expect(() => resolveHome({ ...base, args: { profile } })).toThrow(HomeArgsError);
  });

  it.each(['a', '0', 'test-1', 'a'.repeat(32)])('接受合法的 profile 名：%j', profile => {
    expect(resolveHome({ ...base, args: { profile } }).home).toBe(`/u/.aalis-${profile}`);
  });

  it('宿主代码给的 defaultHome 必须是绝对路径：不按 cwd 猜，别的来源胜出时也照样报', () => {
    expect(() => resolveHome({ ...base, args: {}, defaultHome: 'rel' })).toThrow(HomeArgsError);
    expect(() => resolveHome({ ...base, env: { AALIS_HOME: '/h' }, args: {}, defaultHome: 'rel' })).toThrow(
      'defaultHome 必须是绝对路径',
    );
  });

  it('环境变量设成空串视同没设', () => {
    expect(resolveHome({ ...base, env: { AALIS_HOME: '', AALIS_PROFILE: '' }, args: {} })).toEqual({
      home: '/u/.aalis',
    });
    expect(resolveHome({ ...base, env: { AALIS_HOME: '/h', AALIS_PROFILE: '' }, args: {} })).toEqual({ home: '/h' });
    expect(resolveHome({ ...base, env: { AALIS_HOME: '', AALIS_PROFILE: 'p' }, args: {} })).toEqual({
      home: '/u/.aalis-p',
      profile: 'p',
    });
  });

  it('家目录是 ~/.aalis-<p> 时不论经哪个来源选中都带 profile；别处的同名目录、不合法的名字不带', () => {
    const test = { home: '/u/.aalis-test', profile: 'test' };
    expect(resolveHome({ ...base, args: { home: '~/.aalis-test' } })).toEqual(test);
    expect(resolveHome({ ...base, env: { AALIS_HOME: '/u/.aalis-test/' }, args: {} })).toEqual({
      ...test,
      home: '/u/.aalis-test/',
    });
    expect(resolveHome({ ...base, args: {}, defaultHome: '/u/.aalis-test' })).toEqual(test);
    expect(resolveHome({ ...base, cwd: '/u', args: { home: '.aalis-test' } })).toEqual(test);
    expect(resolveHome({ ...base, args: { home: '.aalis-test' } })).toEqual({ home: '/work/.aalis-test' });
    expect(resolveHome({ ...base, args: { home: '/elsewhere/.aalis-test' } })).toEqual({
      home: '/elsewhere/.aalis-test',
    });
    expect(resolveHome({ ...base, args: { home: '~/.aalis-Test' } })).toEqual({ home: '/u/.aalis-Test' });
    expect(resolveHome({ ...base, args: { home: '~/.aalis' } })).toEqual({ home: '/u/.aalis' });
  });

  it('开头的 ~ 展开成用户主目录；「~用户名」写法报错', () => {
    expect(resolveHome({ ...base, args: { home: '~/x' } })).toEqual({ home: '/u/x' });
    expect(resolveHome({ ...base, env: { AALIS_HOME: '~' }, args: {} })).toEqual({ home: '/u' });
    expect(() => resolveHome({ ...base, args: { home: '~bob/x' } })).toThrow('不支持「~用户名」写法');
  });

  it('启动目录已不存在（cwd 取不到）时，绝对路径照常可用，相对路径报错', () => {
    const noCwd = { env: {}, userHome: '/u' };
    expect(resolveHome({ ...noCwd, args: { home: '/abs/h' } })).toEqual({ home: '/abs/h' });
    expect(resolveHome({ ...noCwd, args: {} })).toEqual({ home: '/u/.aalis' });
    expect(() => resolveHome({ ...noCwd, args: { home: 'rel' } })).toThrow('当前目录已不存在');
  });
});

// 符号链接在 Windows 上要管理员或开发者模式
describe.skipIf(process.platform === 'win32')('profileOfRealHome', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** 临时目录的真实路径（macOS 的临时目录本身经 /var → /private/var 的链接） */
  const root = () => {
    const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'aalis-profile-')));
    dirs.push(d);
    return d;
  };

  it('家目录的真实路径就是 ~/.aalis-<p> 的真实路径时为 p：用户主目录经链接给出也认得出', () => {
    const r = root();
    const user = join(r, 'user');
    mkdirSync(join(user, '.aalis-t'), { recursive: true });
    symlinkSync(user, join(r, 'user-link'));
    expect(profileOfRealHome(join(user, '.aalis-t'), user)).toBe('t');
    expect(profileOfRealHome(join(user, '.aalis-t'), join(r, 'user-link'))).toBe('t');
  });

  it('别处的同名目录、~/.aalis-<p> 指向的别处、用户主目录不存在：都没有 profile', () => {
    const r = root();
    const user = join(r, 'user');
    mkdirSync(user);
    mkdirSync(join(r, 'other', '.aalis-t'), { recursive: true });
    expect(profileOfRealHome(join(r, 'other', '.aalis-t'), user)).toBeUndefined();
    // ~/.aalis-t 自己是指向别处的链接：经别处的真实路径选中认不出
    symlinkSync(join(r, 'other', '.aalis-t'), join(user, '.aalis-t'));
    expect(profileOfRealHome(join(r, 'other', '.aalis-t'), user)).toBeUndefined();
    expect(profileOfRealHome(join(user, '.aalis-t'), join(r, 'missing'))).toBeUndefined();
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
    expect(() => assertAbsolute('配置文件路径', 'aalis.config.yaml')).toThrow('配置文件路径必须是绝对路径');
    expect(() => assertAbsolute('配置文件路径', '/h/aalis.config.yaml')).not.toThrow();
  });

  it('宿主件的路径参数拒收相对路径，不按调用那一刻的 cwd 解析', async () => {
    expect(() => createFsYamlConfigProvider('aalis.config.yaml')).toThrow('配置文件路径必须是绝对路径');
    expect(() => createFsPluginLoader('packages')).toThrow('packages 目录必须是绝对路径');
    expect(() => createNodeModulesPluginLoader('.')).toThrow('安装集目录必须是绝对路径');
    await expect(setupFileLogger('logs/latest.log')).rejects.toThrow('日志文件路径必须是绝对路径');
  });
});

describe('derivePaths', () => {
  it('布局全部挂在家目录下，安装集单独给', () => {
    const p = derivePaths('/h', '/app', 'p');
    expect(p).toMatchObject({
      home: '/h',
      profile: 'p',
      app: '/app',
      config: '/h/aalis.config.yaml',
      secrets: '/h/secrets.yaml',
      state: '/h/state',
      logs: '/h/logs',
      run: '/h/run',
      tmp: '/h/tmp',
      self: { personas: '/h/self/personas', skills: '/h/self/skills', workflows: '/h/self/workflows' },
      stage: { drafts: '/h/stage/drafts', public: '/h/stage/public', paper: '/h/stage/paper' },
    });
    expect('profile' in derivePaths('/h', '/app')).toBe(false);
  });

  it('交给插件的路径对象是冻结的：一处改了不会带偏别的插件', () => {
    const p = derivePaths('/h', '/app');
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.self)).toBe(true);
    expect(Object.isFrozen(p.stage)).toBe(true);
  });
});

describe('initHome', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'aalis-home-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('建目录与两个文件，权限收紧；之后算已初始化', () => {
    const paths = derivePaths(join(tmp(), 'h'), '/app');
    expect(isHomeInitialized(paths)).toBe(false);
    initHome(paths);
    expect(isHomeInitialized(paths)).toBe(true);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(statSync(paths.tmp).mode & 0o777).toBe(0o700);
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(statSync(paths.secrets).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.secrets, 'utf-8')).toBe('');
    expect(statSync(paths.stage.paper).isDirectory()).toBe(true);
  });

  it('已存在的空目录沿用并收紧为 0700', () => {
    const home = join(tmp(), 'h');
    mkdirSync(home);
    // 显式放宽：umask 为 077 时 mkdir 建出来就是 0700，不放宽这条用例什么也测不到
    chmodSync(home, 0o755);
    expect(statSync(home).mode & 0o777).toBe(0o755);
    initHome(derivePaths(home, '/app'));
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it('已初始化时拒绝，不碰现有文件', () => {
    const paths = derivePaths(tmp(), '/app');
    writeFileSync(paths.config, 'name: mine\n');
    writeFileSync(paths.secrets, 'k: v\n');
    expect(() => initHome(paths)).toThrow('已经初始化过');
    expect(readFileSync(paths.config, 'utf-8')).toBe('name: mine\n');
    expect(readFileSync(paths.secrets, 'utf-8')).toBe('k: v\n');
  });

  it('上次初始化中途失败（布局与 secrets.yaml 在、主配置没写）时可以重来：不清掉 secrets.yaml，并收紧它的权限', () => {
    const paths = derivePaths(tmp(), '/app');
    mkdirSync(paths.state);
    mkdirSync(paths.self.skills, { recursive: true });
    writeFileSync(paths.secrets, 'k: v\n');
    chmodSync(paths.secrets, 0o644);
    writeFileSync(join(paths.home, '.DS_Store'), '');
    initHome(paths);
    expect(isHomeInitialized(paths)).toBe(true);
    expect(readFileSync(paths.secrets, 'utf-8')).toBe('k: v\n');
    expect(statSync(paths.secrets).mode & 0o777).toBe(0o600);
  });

  it('安装集装了会话管理与终端、WebUI：两个平台档开箱给全部工具分组；多人平台不代开', () => {
    const app = join(tmp(), 'app');
    mkdirSync(app);
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        dependencies: { '@aalis/plugin-session-manager': '^0.1.0', '@aalis/plugin-cli': '^0.1.0' },
        optionalDependencies: { '@aalis/plugin-webui-server': '^0.1.0', '@aalis/plugin-adapter-onebot': '^0.1.0' },
      }),
    );
    const paths = derivePaths(join(tmp(), 'h'), app);
    initHome(paths);
    expect(parseYaml(readFileSync(paths.config, 'utf-8'))).toEqual({
      name: 'Aalis',
      logLevel: 'info',
      plugins: {},
      sessionConfig: { platforms: { cli: { enabledToolGroups: ['*'] }, webui: { enabledToolGroups: ['*'] } } },
    });
  });

  it('安装集没有 package.json（还没装插件）：不写平台档', () => {
    const paths = derivePaths(join(tmp(), 'h'), join(tmp(), 'app'));
    initHome(paths);
    expect(parseYaml(readFileSync(paths.config, 'utf-8'))).toEqual({ name: 'Aalis', logLevel: 'info', plugins: {} });
  });

  it('安装集的 package.json 读不了：点名文件报错，什么都不建', () => {
    const app = tmp();
    writeFileSync(join(app, 'package.json'), '{ not json');
    const paths = derivePaths(join(tmp(), 'h'), app);
    expect(() => initHome(paths)).toThrow(join(app, 'package.json'));
    expect(existsSync(paths.home)).toBe(false);
  });

  it('目录里有布局以外的东西时拒绝：不把用户主目录或仓库改成 0700、再往里铺布局', () => {
    const home = tmp();
    chmodSync(home, 0o755);
    writeFileSync(join(home, 'notes.txt'), 'x');
    mkdirSync(join(home, 'src'));
    expect(() => initHome(derivePaths(home, '/app'))).toThrow('目录不是空的（有 notes.txt、src）');
    expect(statSync(home).mode & 0o777).toBe(0o755);
    expect(existsSync(join(home, 'state'))).toBe(false);
    expect(existsSync(join(home, 'secrets.yaml'))).toBe(false);
  });
});

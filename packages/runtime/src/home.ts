import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { HOME_DIR, type HostPaths } from '@aalis/api-host-paths';
import { CORE_CONFIG_SCHEMA, defaultsFrom } from '@aalis/schema-config';
import { stringify as stringifyYaml } from 'yaml';

// ============================================================
// 家目录：解析、路径派生与初始化
// ============================================================
//
// 家目录装着一个实例的全部状态与密钥，只在这里解析，core 不参与。进程的 cwd 不带语义：
// 唯一的例外是命令行与环境变量里写的相对路径，它们按启动时的 cwd 解析一次（那是用户在 shell 里的意图），
// 之后全程只用绝对路径。

/** 宿主件的路径参数必须是绝对路径：相对路径会按调用那一刻的 cwd 解析，而 cwd 不带语义 */
export function assertAbsolute(what: string, p: string): void {
  if (!isFullyAbsolute(p)) throw new Error(`${what} must be an absolute path: ${p}`);
}

/** profile 名既拼进 `data-<profile>`，也拼进数据库名：只许小写字母、数字与连字符，挡住 `../x` 这类跳出。 */
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const CONFIG_FILE = 'aalis.config.yaml';
const SECRETS_FILE = 'secrets.yaml';

/** `--init` 只在空目录、或只有布局自己的条目（上次初始化中途失败留下的）的目录里做 */
const LAYOUT_ENTRIES: ReadonlySet<string> = new Set([
  'state',
  'logs',
  'cache',
  'run',
  'tmp',
  'self',
  'workspace',
  SECRETS_FILE,
  '.DS_Store',
]);

/**
 * 绝对路径。Windows 上还要带盘符或 UNC 前缀：`\aalis` 这类按当前盘解析，仍然依赖 cwd。
 */
export function isFullyAbsolute(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p) : isAbsolute(p);
}

/** 家目录相关的输入有误（参数缺值、profile 名不合法、来源冲突）：宿主据此一行报错退出。 */
export class HomeArgsError extends Error {
  override name = 'HomeArgsError';
}

/** 出现在子命令之前的宿主参数。 */
export interface HostArgs {
  home?: string;
  profile?: string;
  /** `--init`：初始化家目录后退出 */
  init: boolean;
  /** `--service`：由服务管理器拉起；实例锁被占时按正常退出，免得被反复拉起 */
  service: boolean;
  /** 余下的 argv：非空即子命令 */
  rest: string[];
}

/**
 * 只认开头的宿主参数（`--home <dir>`、`--home=<dir>`、`--profile`、`--init`、`--service`），遇到第一个别的参数即停：
 * 之后的都属于子命令，子命令自己的参数里出现同名写法也不会被吃掉。
 * 开头这一段里的 `--` 跳过：`pnpm dev -- --init` 会把 `--` 原样传进来。
 */
export function parseHostArgs(argv: readonly string[]): HostArgs {
  const out: HostArgs = { init: false, service: false, rest: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (arg === '--init' || arg === '--service') {
      out[arg === '--init' ? 'init' : 'service'] = true;
      continue;
    }
    const m = /^--(home|profile)(?:=(.*))?$/.exec(arg);
    if (!m) break;
    const key = m[1] as 'home' | 'profile';
    const value = m[2] ?? argv[++i];
    if (!value) throw new HomeArgsError(`--${key} is missing a value`);
    out[key] = value;
  }
  out.rest = argv.slice(i);
  return out;
}

export interface ResolveHomeInput {
  args: Pick<HostArgs, 'home' | 'profile'>;
  env: Readonly<Record<string, string | undefined>>;
  /** 部署目录（安装集），必须是绝对路径：没另行指定时家目录在它下面 */
  appDir: string;
  /** 解析命令行与环境变量里相对路径的基准：启动时的 cwd。取不到（目录已被删除）时不给，只有遇到相对路径才需要它 */
  cwd?: string;
  /** 用户主目录：展开 `--home`、`AALIS_HOME` 开头的 `~` */
  userHome?: string;
}

/**
 * 家目录的覆盖顺序：`--home` → `AALIS_HOME` → 部署目录下的 `data/`；给了 `--profile` / `AALIS_PROFILE` 时是部署目录下的
 * `data-<p>/`。家目录不放在用户主目录下：一个部署的配置、数据与日志都在部署目录里。
 * 指定了 profile、同时又有 `--home` 或 `AALIS_HOME` 时报错，不静默忽略 profile：以为进了测试实例、实际写进主实例，
 * 是这类配置错误最坏的后果。profile 只由这两处给，经 `--home` 选中的目录不论叫什么都没有 profile。
 */
export function resolveHome(input: ResolveHomeInput): { home: string; profile?: string } {
  const { args, env, appDir } = input;
  // 部署目录是宿主代码给的值：写错了不论这次谁胜出都报，免得换一台没设环境变量的机器才暴露
  if (!isFullyAbsolute(appDir)) throw new HomeArgsError(`appDir must be an absolute path: ${appDir}`);
  // 环境变量设成空串（`AALIS_HOME=` 用来清掉它）视同没设
  const explicit = args.home ?? nonEmpty(env.AALIS_HOME);
  const profile = args.profile ?? nonEmpty(env.AALIS_PROFILE);
  if (explicit !== undefined && profile !== undefined) {
    const homeSource = args.home !== undefined ? '--home' : 'AALIS_HOME';
    const profileSource = args.profile !== undefined ? '--profile' : 'AALIS_PROFILE';
    throw new HomeArgsError(`Both ${homeSource} and ${profileSource} are set; use only one of them`);
  }
  if (explicit !== undefined) return { home: toAbsolute(explicit, input.userHome ?? homedir(), input.cwd) };
  if (profile === undefined) return { home: join(normalize(appDir), HOME_DIR) };
  if (!PROFILE_PATTERN.test(profile)) {
    throw new HomeArgsError(
      `Invalid profile name "${profile}": use only lowercase letters, digits and hyphens, start with a letter or digit, and keep it within 32 characters`,
    );
  }
  return { home: join(normalize(appDir), `${HOME_DIR}-${profile}`), profile };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

/**
 * 命令行与环境变量里的家目录写法转成绝对路径。开头的 `~` 展开成用户主目录：`--home=~/x` 不经 shell 展开，
 * launchd、systemd 与容器的环境变量也不展开，不处理就会在 cwd 下建出一个名叫 `~` 的目录。
 */
function toAbsolute(value: string, userHome: string, cwd: string | undefined): string {
  if (value === '~') return userHome;
  if (/^~[\\/]/.test(value)) return join(userHome, value.slice(2));
  if (value.startsWith('~')) {
    throw new HomeArgsError(`"~user" paths are not supported; write an absolute path: ${value}`);
  }
  if (isFullyAbsolute(value)) return normalize(value);
  if (cwd === undefined) {
    throw new HomeArgsError(
      `The current directory no longer exists; write the home directory as an absolute path: ${value}`,
    );
  }
  return resolve(cwd, value);
}

/** 由家目录与安装集派生全部路径（家目录布局见计划书「家目录布局」）。 */
export function derivePaths(home: string, app: string, profile?: string): HostPaths {
  // 冻结：同一个对象交给每个插件，任何一处改了它（例如改 app）都会把别的插件的装卸目录一起带偏
  return Object.freeze({
    home,
    ...(profile !== undefined ? { profile } : {}),
    app,
    config: join(home, CONFIG_FILE),
    secrets: join(home, SECRETS_FILE),
    state: join(home, 'state'),
    logs: join(home, 'logs'),
    cache: join(home, 'cache'),
    run: join(home, 'run'),
    tmp: join(home, 'tmp'),
    self: join(home, 'self'),
    workspace: join(home, 'workspace'),
  });
}

/** 初始化的判据：主配置文件存在。 */
export function isHomeInitialized(paths: HostPaths): boolean {
  return existsSync(paths.config);
}

/**
 * 建家目录：目录 0700，写默认主配置与空的密钥文件（0600），建布局里的子目录。主配置只有名字、日志级别与空的插件段。
 * 已初始化时拒绝，不覆盖任何文件。目录已存在时只接受空目录，或只有布局自己条目的目录（上次初始化中途失败），
 * 沿用并收紧为 0700：`--home ~ --init` 这类笔误不能把用户主目录改成 0700、再往里铺一层布局。
 */
export function initHome(paths: HostPaths): void {
  if (isHomeInitialized(paths)) throw new HomeArgsError(`The home directory is already initialized: ${paths.home}`);
  if (existsSync(paths.home)) {
    const foreign = readdirSync(paths.home).filter(name => !LAYOUT_ENTRIES.has(name));
    if (foreign.length > 0) {
      const shown = foreign.slice(0, 3).join(', ') + (foreign.length > 3 ? ' and more' : '');
      throw new HomeArgsError(
        `The directory is not empty (it contains ${shown}); cannot initialize a home directory here: ${paths.home}`,
      );
    }
  }
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);
  for (const dir of [paths.state, paths.logs, paths.cache, paths.run, paths.self, paths.workspace]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(paths.tmp, { recursive: true, mode: 0o700 });
  // 密钥文件先建：主配置是初始化的判据，最后写，中途失败时下次仍能重新初始化
  if (existsSync(paths.secrets)) chmodSync(paths.secrets, 0o600);
  else writeFileSync(paths.secrets, '', { mode: 0o600, flag: 'wx' });
  const { name, logLevel } = defaultsFrom(CORE_CONFIG_SCHEMA);
  writeFileSync(paths.config, stringifyYaml({ name, logLevel, plugins: {} }), {
    mode: 0o600,
    flag: 'wx',
  });
}

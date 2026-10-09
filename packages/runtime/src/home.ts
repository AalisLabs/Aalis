import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import type { HostPaths } from '@aalis/api-host-paths';
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
  if (!isFullyAbsolute(p)) throw new Error(`${what}必须是绝对路径：${p}`);
}

/** profile 名既拼进 `~/.aalis-<profile>`，也拼进数据库名：只许小写字母、数字与连字符，挡住 `../x` 这类跳出。 */
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
  'stage',
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
    if (!value) throw new HomeArgsError(`--${key} 缺少取值`);
    out[key] = value;
  }
  out.rest = argv.slice(i);
  return out;
}

export interface ResolveHomeInput {
  args: Pick<HostArgs, 'home' | 'profile'>;
  env: Readonly<Record<string, string | undefined>>;
  /** 宿主代码给的兜底家目录，优先级最低，必须是绝对路径 */
  defaultHome?: string;
  /** 解析命令行与环境变量里相对路径的基准：启动时的 cwd。取不到（目录已被删除）时不给，只有遇到相对路径才需要它 */
  cwd?: string;
  /** 用户主目录 */
  userHome?: string;
}

/**
 * 家目录的覆盖顺序：`--home` → `AALIS_HOME` → `--profile` / `AALIS_PROFILE`（`~/.aalis-<p>`）→ 宿主的 defaultHome → `~/.aalis`。
 * 指定了 profile、同时又有更高优先级的 `--home` 或 `AALIS_HOME` 时报错，不静默忽略 profile：
 * 以为进了测试实例、实际写进主实例，是这类配置错误最坏的后果。
 */
export function resolveHome(input: ResolveHomeInput): { home: string; profile?: string } {
  const { args, env } = input;
  const userHome = input.userHome ?? homedir();
  // 环境变量设成空串（`AALIS_HOME=` 用来清掉它）视同没设
  const explicit = args.home ?? nonEmpty(env.AALIS_HOME);
  const profile = args.profile ?? nonEmpty(env.AALIS_PROFILE);
  // defaultHome 是宿主代码写死的值：写错了不论这次谁胜出都报，免得换一台没设环境变量的机器才暴露
  if (input.defaultHome !== undefined && !isFullyAbsolute(input.defaultHome)) {
    throw new HomeArgsError(`defaultHome 必须是绝对路径：${input.defaultHome}`);
  }
  if (explicit !== undefined && profile !== undefined) {
    const homeSource = args.home !== undefined ? '--home' : 'AALIS_HOME';
    const profileSource = args.profile !== undefined ? '--profile' : 'AALIS_PROFILE';
    throw new HomeArgsError(`同时指定了 ${homeSource} 与 ${profileSource}，只能选一个`);
  }
  if (explicit !== undefined) return withProfile(toAbsolute(explicit, userHome, input.cwd), userHome);
  if (profile !== undefined) {
    if (!PROFILE_PATTERN.test(profile)) {
      throw new HomeArgsError(
        `profile 名「${profile}」不合法：只能用小写字母、数字与连字符，以字母或数字开头，最长 32 个字符`,
      );
    }
    return { home: join(userHome, `.aalis-${profile}`), profile };
  }
  if (input.defaultHome !== undefined) return withProfile(normalize(input.defaultHome), userHome);
  return { home: join(userHome, '.aalis') };
}

/**
 * `~/.aalis-<p>` 就是 profile p 的家目录：经 `--home`、`AALIS_HOME` 或 defaultHome 选中它时同样带上 profile，
 * 插件按 profile 派生的名字（如记忆库名）对同一个家目录才一样。这里按路径的写法认，认不出的写法由
 * {@link profileOfRealHome} 按真实路径补认。
 */
function withProfile(home: string, userHome: string): { home: string; profile?: string } {
  const profile = /^\.aalis-(.+)$/.exec(basename(home))?.[1];
  if (profile === undefined || !PROFILE_PATTERN.test(profile)) return { home };
  return resolve(home) === resolve(userHome, `.aalis-${profile}`) ? { home, profile } : { home };
}

/**
 * 按真实路径补认 profile：家目录的真实路径就是 `~/.aalis-<p>` 的真实路径时为 p。补上按写法认不出的情形：
 * 大小写写错、经指向它的符号链接选中、用户主目录本身是符号链接。`~/.aalis-<p>` 自己是指向别处的链接时，
 * 经那个别处的路径选中仍认不出。用户主目录不存在时没有 profile。
 */
export function profileOfRealHome(realHome: string, userHome: string = homedir()): string | undefined {
  let realUserHome: string;
  try {
    realUserHome = realpathSync.native(userHome);
  } catch {
    return undefined;
  }
  return withProfile(realHome, realUserHome).profile;
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
  if (value.startsWith('~')) throw new HomeArgsError(`不支持「~用户名」写法，请写绝对路径：${value}`);
  if (isFullyAbsolute(value)) return normalize(value);
  if (cwd === undefined) throw new HomeArgsError(`当前目录已不存在，家目录请写绝对路径：${value}`);
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
    self: Object.freeze({
      personas: join(home, 'self', 'personas'),
      skills: join(home, 'self', 'skills'),
      workflows: join(home, 'self', 'workflows'),
    }),
    stage: Object.freeze({
      drafts: join(home, 'stage', 'drafts'),
      public: join(home, 'stage', 'public'),
      paper: join(home, 'stage', 'paper'),
    }),
  });
}

/** 初始化的判据：主配置文件存在。 */
export function isHomeInitialized(paths: HostPaths): boolean {
  return existsSync(paths.config);
}

/**
 * 只有 owner 进得来的平台（本地终端、单 token 的 WebUI）的平台档开箱给全部工具分组，无条件写：平台没装时这一层不起作用，
 * 之后从市场装上即生效。多人平台不代开：带分组的工具默认不暴露，public 工具在群里的可达性靠这道分组闸。与 create-aalis 生成的平台档一致
 */
const OWNER_PLATFORM_PROFILES = { cli: { enabledToolGroups: ['*'] }, webui: { enabledToolGroups: ['*'] } };

/**
 * 建家目录：目录 0700，写默认主配置与空的密钥文件（0600），建布局里的子目录。主配置里写上 owner 平台的平台档。
 * 已初始化时拒绝，不覆盖任何文件。目录已存在时只接受空目录，或只有布局自己条目的目录（上次初始化中途失败），
 * 沿用并收紧为 0700：`--home ~ --init` 这类笔误不能把用户主目录改成 0700、再往里铺一层布局。
 */
export function initHome(paths: HostPaths): void {
  if (isHomeInitialized(paths)) throw new HomeArgsError(`家目录已经初始化过：${paths.home}`);
  if (existsSync(paths.home)) {
    const foreign = readdirSync(paths.home).filter(name => !LAYOUT_ENTRIES.has(name));
    if (foreign.length > 0) {
      const shown = foreign.slice(0, 3).join('、') + (foreign.length > 3 ? ' 等' : '');
      throw new HomeArgsError(`目录不是空的（有 ${shown}），不能在这里初始化家目录：${paths.home}`);
    }
  }
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);
  for (const dir of [
    paths.state,
    paths.logs,
    paths.cache,
    paths.run,
    paths.self.personas,
    paths.self.skills,
    paths.self.workflows,
    paths.stage.drafts,
    paths.stage.public,
    paths.stage.paper,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(paths.tmp, { recursive: true, mode: 0o700 });
  // 密钥文件先建：主配置是初始化的判据，最后写，中途失败时下次仍能重新初始化
  if (existsSync(paths.secrets)) chmodSync(paths.secrets, 0o600);
  else writeFileSync(paths.secrets, '', { mode: 0o600, flag: 'wx' });
  const { name, logLevel } = defaultsFrom(CORE_CONFIG_SCHEMA);
  const sessionConfig = { platforms: OWNER_PLATFORM_PROFILES };
  writeFileSync(paths.config, stringifyYaml({ name, logLevel, plugins: {}, sessionConfig }), {
    mode: 0o600,
    flag: 'wx',
  });
}

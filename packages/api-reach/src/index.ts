/**
 * @aalis/api-reach — 触及契约
 *
 * 一次工具调用最多能触及本机的什么：先按「主体 × 房间类别」定上限，只有 owner 在受众只有 owner 的会话里有本地效果；
 * 再按档位收窄，按污点把送出会话的动作改成问；子任务另与父会话实时的触及取较小值。本包只有类型与纯函数：
 * - 档位与越界策略，经 declaration merging 成为会话设置的两个键；
 * - `resolveReach` 解析出一份触及，`judgeReach` 判一个目标放行、问或拒；
 * - `protectedLists` 生成宿主控制面、持久化与自动执行落点、拒读清单三张清单，工具边界与沙箱用同一份；
 * - `sandboxPolicyOf` 按触及生成沙箱策略；
 * - 触及凭据 `ReachCredential` 的类型与品牌符号：凭据只由触及插件构造，工具从调用上下文取得后转交；
 * - 触及服务 `reach`：按一次工具调用签发凭据，存会话的污点与白纸的来源账本。
 *
 * 路径一律是真实路径：符号链接已解开；目标不存在时，取最近存在的祖先的真实路径，再接上后面不存在的各段。由调用方取好再交进来。
 */

import type { OriginTurn } from '@aalis/api-authority';
import type { HostPaths } from '@aalis/api-host-paths';
import type { RoomClass, WorkBinding } from '@aalis/api-session-manager';
import { defineService } from '@aalis/core';

// ════════════════════════════════════════════════════════════
// 档位
// ════════════════════════════════════════════════════════════

/** 权限四档，从低到高：只读、修改确认、工作区、全权。降档即在这张表里往前挪 */
export const ACCESS_TIERS = ['readonly', 'confirm', 'workspace', 'full'] as const;
export type AccessTier = (typeof ACCESS_TIERS)[number];

/**
 * 越界策略：需要问的时候在场就问、不在场按拒绝（ask），或一律直接拒绝（deny）。对修改确认档不起作用，那一档本身就是逐步确认
 */
export type BoundaryPolicy = 'ask' | 'deny';

declare module '@aalis/api-session-manager' {
  interface SessionConfig {
    /** 档位：只对 owner 自己的会话起作用，子会话按根会话实时取 */
    accessTier?: AccessTier;
    /** 越界策略：子会话按根会话实时取 */
    accessOnBoundary?: BoundaryPolicy;
  }
}

// ════════════════════════════════════════════════════════════
// 路径规则与三张清单
// ════════════════════════════════════════════════════════════

/**
 * 路径匹配：`path` 是这个路径与它下面的全部；`pattern` 是对整条路径的正则（源码），只用锚点、字符类、分组与选择、量词，
 * 沙箱的生成器才翻译得了。macOS 与 Windows 上不分大小写，Windows 上反斜杠按斜杠比较
 */
export type PathMatcher = { readonly path: string } | { readonly pattern: string };

/** 清单里的一条：命中 matcher 且不在 except 里 */
export type PathRule = PathMatcher & { readonly except?: readonly PathMatcher[] };

/** 路径落在这条规则里：命中它、且不在它的例外里 */
export function matchesRule(rule: PathRule, path: string, platform: NodeJS.Platform): boolean {
  return hit(rule, path, platform) && !rule.except?.some(matcher => hit(matcher, path, platform));
}

function hit(matcher: PathMatcher, path: string, platform: NodeJS.Platform): boolean {
  const key = keyOf(path, platform);
  if ('pattern' in matcher) return new RegExp(matcher.pattern, foldsCase(platform) ? 'i' : '').test(key);
  const root = keyOf(matcher.path, platform);
  return key === root || key.startsWith(root.endsWith('/') ? root : `${root}/`);
}

const foldsCase = (platform: NodeJS.Platform) => platform === 'darwin' || platform === 'win32';
const slash = (path: string, platform: NodeJS.Platform) => (platform === 'win32' ? path.replaceAll('\\', '/') : path);
const keyOf = (path: string, platform: NodeJS.Platform) =>
  foldsCase(platform) ? slash(path, platform).toLowerCase() : slash(path, platform);
/** 把一个路径原样嵌进正则 */
const literal = (path: string, platform: NodeJS.Platform) =>
  slash(path, platform).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ProtectedListsInput {
  /** 家目录布局 */
  readonly paths: HostPaths;
  /** 操作系统用户的家目录 */
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
  /** 安装集以外、守护进程加载了代码的目录，如经链接装进来的插件 */
  readonly codeDirs: readonly string[];
}

export interface ProtectedLists {
  readonly platform: NodeJS.Platform;
  /** 宿主控制面：任何档位都拒绝写，不可申请 */
  readonly control: readonly PathRule[];
  /**
   * 持久化与自动执行落点：只读与工作区档按越界策略问或拒，修改确认档问，全权写入并记审计。装着落点的目录本身也算，
   * 免得在别处摆好整棵子树再改名到位。伪装裸仓库要的 HEAD 与不叫 .git 的 git 目录由触及按它的 git 目录补上
   */
  readonly landing: readonly PathRule[];
  /** 拒读清单：工具边界在任何档位都拒读，沙箱里同样读不到；在宿主上执行的命令（全权、修改确认，以及批准过的宿主执行）约束不到 */
  readonly denyRead: readonly PathRule[];
}

const MAC_BROWSERS = [
  'Library/Application Support/Google',
  'Library/Application Support/Chromium',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Microsoft Edge Beta',
  'Library/Application Support/Microsoft Edge Dev',
  'Library/Application Support/Microsoft Edge Canary',
  'Library/Application Support/Firefox',
  'Library/Application Support/Vivaldi',
  'Library/Application Support/Arc',
  'Library/Application Support/com.operasoftware.Opera',
  'Library/Application Support/com.operasoftware.OperaGX',
  'Library/Safari',
  'Library/Containers/com.apple.Safari',
  'Library/Cookies',
];

const LINUX_BROWSERS = [
  '.config/google-chrome',
  '.config/google-chrome-beta',
  '.config/google-chrome-unstable',
  '.config/chromium',
  '.config/BraveSoftware',
  '.config/microsoft-edge',
  '.config/microsoft-edge-beta',
  '.config/microsoft-edge-dev',
  '.config/vivaldi',
  '.config/opera',
  '.mozilla',
  'snap/firefox',
  'snap/chromium',
  'snap/brave',
  // Flatpak 装的浏览器
  '.var/app/org.mozilla.firefox',
  '.var/app/com.google.Chrome',
  '.var/app/org.chromium.Chromium',
  '.var/app/com.brave.Browser',
  '.var/app/com.microsoft.Edge',
];

/**
 * git 目录里的落点（接在 git 目录后面）：钩子、配置、commondir（git 把它指向的目录当共用目录，配置与钩子都从那里取）；
 * 子模块的名字可以带斜杠、可以嵌套，按目录名列不全，modules 整棵都算；worktree 的管理目录本身也算，免得整棵改名到位
 */
const GIT_DIR_LANDING = '(hooks(/|$)|config$|(.+/)?(config\\.worktree|commondir)$|modules(/|$)|worktrees(/[^/]+)?$)';

/** 按家目录布局、用户家目录与平台生成三张清单 */
export function protectedLists(input: ProtectedListsInput): ProtectedLists {
  const { paths, platform } = input;
  const mac = platform === 'darwin';
  const linux = platform === 'linux';
  // 用户家目录是根目录（容器里常见）时拼出的是 /.ssh，不是 //.ssh
  const userHome = input.userHome.replace(/\/+$/, '');
  const inUserHome = (...rels: string[]): PathRule[] => rels.map(rel => ({ path: `${userHome}/${rel}` }));
  /** 路径的上一级 */
  const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
  /** 任何目录下的同名条目 */
  const named = (tail: string): PathRule => ({ pattern: `/${tail}` });
  return {
    platform,
    control: [
      // 家目录下只有白纸、临时区与技能目录可写：公开区只经发布插件写入，编排定义只经定义工具写入
      { path: paths.home, except: [{ path: paths.stage.paper }, { path: paths.tmp }, { path: paths.self.skills }] },
      // 守护进程加载的代码：安装集的依赖与构建产物（源码形态下另有各包的），以及安装集以外加载的插件
      { path: `${paths.app}/node_modules` },
      { path: `${paths.app}/dist` },
      { pattern: `^${literal(paths.app, platform)}/packages/[^/]+/(dist|node_modules)(/|$)` },
      ...input.codeDirs.map(path => ({ path })),
    ],
    landing: [
      // git：.git 本身（子模块工作树里文件形式的也是），与它里面的落点
      named(`\\.git($|/${GIT_DIR_LANDING})`),
      // shell 与登录
      ...inUserHome(
        '.profile',
        '.bashrc',
        '.bash_profile',
        '.bash_login',
        '.bash_logout',
        '.zshenv',
        '.zprofile',
        '.zshrc',
        '.zlogin',
        '.zlogout',
        '.kshrc',
        '.cshrc',
        '.tcshrc',
        '.login',
        '.logout',
        '.config/fish',
        '.ssh',
        '.gitconfig',
        '.config/git',
      ),
      ...(mac ? inUserHome('Library/LaunchAgents') : []),
      ...(linux ? inUserHome('.config/systemd/user', '.config/autostart') : []),
      // 装着上面这些的目录本身
      ...['.config', ...(linux ? ['.config/systemd'] : []), ...(mac ? ['Library'] : [])].map(rel => ({
        pattern: `^${literal(`${userHome}/${rel}`, platform)}$`,
      })),
      // 项目里会被工具自动执行的配置，其他代理与编辑器的可执行配置
      named('\\.envrc$'),
      named('\\.(vscode|claude|cursor|codex)$'),
      named('\\.vscode/(tasks|settings)\\.json$'),
      named('[^/]*\\.code-workspace$'),
      named('\\.husky(/|$)'),
      named('\\.pre-commit-config\\.yaml$'),
      named('\\.claude/settings(\\.local)?\\.json$'),
      named('\\.mcp\\.json$'),
      named('\\.cursor/(hooks|mcp|permissions|sandbox|cli)\\.json$'),
      named('\\.codex/(config\\.toml|hooks\\.json)$'),
      named('\\.codex/(rules|hooks)(/|$)'),
      // 项目指令与项目级设置；实例家目录自己也可能叫 .aalis，不算，但它里面（如白纸里的项目）再出现的照样算
      named('(AALIS|AGENTS)\\.md$'),
      { pattern: '/\\.aalis(/|$)', except: [{ path: paths.home }] },
      { pattern: `^${literal(paths.home, platform)}/.+/\\.aalis(/|$)` },
    ],
    denyRead: [
      // 家目录下只放行舞台、self 两个目录整个、本实例的日志与主配置；本会话临时区由触及按会话放回
      {
        path: paths.home,
        except: [parentOf(paths.stage.paper), parentOf(paths.self.skills), paths.logs, paths.config].map(path => ({
          path,
        })),
      },
      // 同一用户下其他实例的家目录
      { pattern: `^${literal(userHome, platform)}/\\.aalis(-[^/]*)?(/|$)`, except: [{ path: paths.home }] },
      // 凭据
      ...inUserHome(
        '.ssh',
        '.aws',
        '.config/gh',
        '.gnupg',
        '.npmrc',
        '.netrc',
        '.git-credentials',
        '.docker/config.json',
        '.kube/config',
      ),
      ...(mac ? inUserHome('Library/Keychains') : []),
      { pattern: '/\\.env[^/]*(/|$)', except: [{ pattern: '/\\.env\\.(example|sample|template)$' }] },
      // 浏览器的配置与数据
      ...(mac ? inUserHome(...MAC_BROWSERS) : []),
      ...(linux ? inUserHome(...LINUX_BROWSERS) : []),
    ],
  };
}

// ════════════════════════════════════════════════════════════
// 触及
// ════════════════════════════════════════════════════════════

/** 发起这一轮的主体。子任务不自己定主体，随发起它的父会话实时的触及 */
export type ReachPrincipal = 'owner' | 'other' | { readonly subtaskOf: Reach };

export interface ReachInput {
  readonly principal: ReachPrincipal;
  /** 会话的房间类别（子会话取根会话的） */
  readonly roomClass: RoomClass;
  /** 生效的档位与越界策略（子会话取根会话的） */
  readonly tier: AccessTier;
  readonly onBoundary: BoundaryPolicy;
  /** 这个会话读进过谁的内容（来源称呼）；不给或为空即干净 */
  readonly tainted?: readonly string[];
  /** 场所的主目录与白纸：默认工作区两者是同一处，项目工作区的主目录是绑定目录 */
  readonly place: { readonly home: string; readonly paper: string };
  /** 项目会话的附加可写目录与本会话树建的 worktree */
  readonly binding?: Pick<WorkBinding, 'extraRoots' | 'worktrees'>;
  /** 绑定所在仓库的 git 目录（common dir）：工作区档可写，落点除外 */
  readonly gitDirs: readonly string[];
  /** 本会话临时区 */
  readonly sessionTmp: string;
  /** 别人的内容所在：别人场所的白纸与来源账本里的文件。文件工具读得到（读了计污点），干净回合的沙箱读不到、改不了 */
  readonly othersContent: readonly string[];
  /** 沙箱里拒连的本机端口 */
  readonly localPorts: readonly number[];
  readonly lists: ProtectedLists;
  readonly paths: HostPaths;
}

/** 有本地效果的触及：只有 owner 在受众只有 owner 的会话里才有 */
export interface LocalReach {
  /** 命令在哪执行：只读与工作区档在沙箱里，修改确认与全权在宿主上 */
  readonly exec: 'sandbox' | 'host';
  readonly tier: AccessTier;
  readonly onBoundary: BoundaryPolicy;
  /** 读进过谁的内容；干净时没有 */
  readonly tainted?: readonly string[];
  /** 场所的主目录与白纸 */
  readonly home: string;
  readonly paper: string;
  readonly sessionTmp: string;
  readonly skills: string;
  /** 工作区档的可写范围：场所的主目录与白纸、附加可写目录、本会话树建的 worktree；其余档位为空 */
  readonly workRoots: readonly string[];
  /**
   * 沙箱两档不问就能写的根：只读档只有本会话临时区；工作区档是 workRoots、仓库的 git 目录、本会话临时区与技能目录
   * （受污染时写技能目录属于送出会话，工具边界问、沙箱拒）。修改确认与全权为空
   */
  readonly writable: readonly string[];
  readonly othersContent: readonly string[];
  readonly localPorts: readonly number[];
  /** 这份触及的三张清单：落点按仓库的 git 目录补上（见 resolveReach） */
  readonly lists: ProtectedLists;
}

/** 一份触及：没有本地效果时读写执行一律拒，联网交给资格轴 */
export type Reach = { readonly exec: 'none' } | LocalReach;

const NO_LOCAL: Reach = Object.freeze({ exec: 'none' });

/**
 * 解析触及：只有 owner（子任务随父会话）在 owner-only 的会话里有本地效果；子任务的档位、越界策略取与父会话较严的那个，
 * 污点并上父会话的。落点按这份触及的 git 目录补上：git 目录不一定叫 .git（裸仓库、分开放的 git 目录），它本身与
 * 它里面的落点照样拦；伪装裸仓库要的 HEAD 是落点，.git 与这些 git 目录里的除外
 */
export function resolveReach(input: ReachInput): Reach {
  const { principal } = input;
  const parent = typeof principal === 'object' ? principal.subtaskOf : undefined;
  if (parent?.exec === 'none' || principal === 'other' || input.roomClass !== 'owner-only') return NO_LOCAL;
  const tier = parent
    ? ACCESS_TIERS[Math.min(ACCESS_TIERS.indexOf(input.tier), ACCESS_TIERS.indexOf(parent.tier))]
    : input.tier;
  const sources = [...new Set([...(input.tainted ?? []), ...(parent?.tainted ?? [])])];
  const tainted = sources.length > 0 ? sources : undefined;
  const { home, paper } = input.place;
  const skills = input.paths.self.skills;
  const workRoots =
    tier === 'workspace'
      ? [...new Set([home, paper, ...(input.binding?.extraRoots ?? []), ...(input.binding?.worktrees ?? [])])]
      : [];
  const writable =
    tier === 'workspace'
      ? [...new Set([...workRoots, ...input.gitDirs, input.sessionTmp, skills])]
      : tier === 'readonly'
        ? [input.sessionTmp]
        : [];
  const landing = [
    ...input.lists.landing,
    { pattern: '/HEAD$', except: [{ pattern: '/\\.git/' }, ...input.gitDirs.map(path => ({ path }))] },
    ...input.gitDirs.map(dir => ({ pattern: `^${literal(dir, input.lists.platform)}($|/${GIT_DIR_LANDING})` })),
  ];
  return {
    exec: tier === 'readonly' || tier === 'workspace' ? 'sandbox' : 'host',
    tier,
    onBoundary: parent?.onBoundary === 'deny' ? 'deny' : input.onBoundary,
    ...(tainted ? { tainted } : {}),
    home,
    paper,
    sessionTmp: input.sessionTmp,
    skills,
    workRoots,
    writable,
    othersContent: input.othersContent,
    localPorts: input.localPorts,
    lists: { ...input.lists, landing },
  };
}

/**
 * 要判的一个目标：读写的真实路径；写一份编排定义（按 id，不是路径）；执行一条命令（host 为要在沙箱外执行）；
 * 联网（模型给的任意网址、要联网的命令、插件固定的服务商）
 */
export type ReachRequest =
  | { readonly effect: 'read' | 'write'; readonly path: string }
  | { readonly effect: 'write'; readonly workflow: string }
  | { readonly effect: 'exec'; readonly host: boolean }
  | { readonly effect: 'network'; readonly via: 'url' | 'command' | 'provider' };

/** 要问的原因：修改确认档、越界（范围外写、宿主执行、只读档联网）、写落点、受污染后送出会话 */
export type ReachAskReason =
  | { readonly kind: 'tier' }
  | { readonly kind: 'boundary'; readonly target: 'write-path' | 'host-exec' | 'network' }
  | { readonly kind: 'landing' }
  | { readonly kind: 'outbound' };

/**
 * 判定：放行（全权写落点另带 landing，要记审计）；问；拒——没有本地效果、宿主控制面与拒读清单不可申请，
 * 越界策略为拒的带着本来要问的原因
 */
export type ReachDecision =
  | { readonly verdict: 'allow'; readonly landing?: true }
  | { readonly verdict: 'ask'; readonly reason: ReachAskReason }
  | { readonly verdict: 'deny'; readonly rule: 'no-local-effect' | 'control-plane' | 'deny-read' }
  | { readonly verdict: 'deny'; readonly rule: 'boundary-policy'; readonly reason: ReachAskReason };

const ALLOW: ReachDecision = { verdict: 'allow' };
const TIER: ReachAskReason = { kind: 'tier' };
const LANDING: ReachAskReason = { kind: 'landing' };
const OUTBOUND: ReachAskReason = { kind: 'outbound' };
const WRITE_PATH: ReachAskReason = { kind: 'boundary', target: 'write-path' };

/** 判一个目标放行、问或拒 */
export function judgeReach(reach: Reach, request: ReachRequest): ReachDecision {
  if (reach.exec === 'none') return request.effect === 'network' ? ALLOW : { verdict: 'deny', rule: 'no-local-effect' };
  const { tier, lists } = reach;
  const ask = (reason: ReachAskReason): ReachDecision =>
    tier !== 'confirm' && reach.onBoundary === 'deny'
      ? { verdict: 'deny', rule: 'boundary-policy', reason }
      : { verdict: 'ask', reason };
  const within = (root: string, path: string) => matchesRule({ path: root }, path, lists.platform);
  const listed = (rules: readonly PathRule[], path: string) =>
    rules.some(rule => matchesRule(rule, path, lists.platform));
  // 受污染时全权以外的档位：送出会话的动作要问
  const outbound = reach.tainted !== undefined && tier !== 'full';
  switch (request.effect) {
    case 'read':
      return within(reach.sessionTmp, request.path) || !listed(lists.denyRead, request.path)
        ? ALLOW
        : { verdict: 'deny', rule: 'deny-read' };
    case 'exec':
      if (tier === 'full') return ALLOW;
      if (tier === 'confirm') return ask(TIER);
      return request.host ? ask({ kind: 'boundary', target: 'host-exec' }) : ALLOW;
    case 'network':
      if (outbound && request.via !== 'provider') return ask(OUTBOUND);
      return tier === 'readonly' ? ask({ kind: 'boundary', target: 'network' }) : ALLOW;
    case 'write':
      if ('path' in request) {
        const { path } = request;
        if (listed(lists.control, path)) return { verdict: 'deny', rule: 'control-plane' };
        if (listed(lists.landing, path)) return tier === 'full' ? { verdict: 'allow', landing: true } : ask(LANDING);
        if (!within(reach.skills, path)) {
          if (tier === 'full') return ALLOW;
          if (tier === 'confirm') return ask(TIER);
          return reach.writable.some(root => within(root, path)) ? ALLOW : ask(WRITE_PATH);
        }
      }
      // 技能目录与编排定义：受污染时属于送出会话；干净时与工作区档的可写范围同等
      if (outbound) return ask(OUTBOUND);
      if (tier === 'confirm') return ask(TIER);
      return tier === 'readonly' ? ask(WRITE_PATH) : ALLOW;
  }
}

// ════════════════════════════════════════════════════════════
// 沙箱策略
// ════════════════════════════════════════════════════════════

/**
 * 沙箱策略：只由触及生成，工具不自己拼。各段的先后（后面的压过前面的），生成器照这个顺序翻译：
 * - 读：默认可读 → readDeny 拒 → readAllowWithin 放回 → provenanceDeny 拒；
 * - 写：默认拒 → write 放 → writeDeny 拒 → writeExceptions 放回 → controlDeny 拒 → provenanceDeny 拒。
 */
export interface SandboxPolicy {
  /** 拒读清单（规则自带例外） */
  readonly readDeny: readonly PathRule[];
  /** 拒读之后放回：本会话临时区 */
  readonly readAllowWithin: readonly string[];
  /** 干净回合里别人的内容：拒读拒写，排在一切放行之后；受污染时为空 */
  readonly provenanceDeny: readonly string[];
  /** 可写的根，含这条命令批准过的范围外写 */
  readonly write: readonly string[];
  /** 落点拒写；受污染时另拒技能目录（写它属于送出会话，批准过的那几处除外） */
  readonly writeDeny: readonly PathRule[];
  /** 拒写之后放回：锚定在可写范围各根下的项目内 node_modules（受污染时技能目录里的不放回），与这条命令按落点批准过的确切路径 */
  readonly writeExceptions: readonly PathRule[];
  /** 宿主控制面拒写，排在所有放行与例外之后 */
  readonly controlDeny: readonly PathRule[];
  /** on：IP 出网，减去 localPorts */
  readonly network: 'off' | 'on';
  /** 拒连的本机端口 */
  readonly localPorts: readonly number[];
  /** 可连的 unix socket 所在的目录：可写范围与本会话临时区，其余一律拒连，与 network 无关 */
  readonly unixSockets: readonly string[];
}

/** 这条命令批准过的提权：按批准时的原因分开放，批准一个目录不连带放回它下面的落点 */
export interface SandboxGrants {
  /** 按范围外写，或受污染时写技能目录（送出会话）批准的路径：并进可写的根，其下的落点照样拒写 */
  readonly writePaths?: readonly string[];
  /** 按落点批准的路径：在拒写之后只放回这一个确切路径 */
  readonly landingPaths?: readonly string[];
  readonly network?: boolean;
}

/** 按触及生成这条命令的沙箱策略；命令不在沙箱里执行的触及（没有本地效果、修改确认、全权）没有沙箱策略 */
export function sandboxPolicyOf(reach: Reach, grants: SandboxGrants = {}): SandboxPolicy {
  if (reach.exec !== 'sandbox') throw new Error(`这次调用的命令不在沙箱里执行（${reach.exec}），没有沙箱策略`);
  const { platform } = reach.lists;
  const writePaths = grants.writePaths ?? [];
  // 技能目录里批准过的那几处：只可能是写技能本身批准的（装着技能目录的范围外目录不算）
  const approvedSkills = writePaths
    .filter(path => matchesRule({ path: reach.skills }, path, platform))
    .map(path => ({ path }));
  return {
    readDeny: reach.lists.denyRead,
    readAllowWithin: [reach.sessionTmp],
    provenanceDeny: reach.tainted ? [] : reach.othersContent,
    write: [...reach.writable, ...writePaths],
    writeDeny: reach.tainted
      ? [...reach.lists.landing, { path: reach.skills, except: approvedSkills }]
      : reach.lists.landing,
    writeExceptions: [
      ...reach.workRoots.map(root => ({
        pattern: `^${literal(root, platform)}/(.*/)?node_modules/`,
        ...(reach.tainted ? { except: [{ path: reach.skills }] } : {}),
      })),
      ...(grants.landingPaths ?? []).map(path => ({ pattern: `^${literal(path, platform)}$` })),
    ],
    controlDeny: reach.lists.control,
    network: grants.network || (reach.tier === 'workspace' && !reach.tainted) ? 'on' : 'off',
    localPorts: reach.localPorts,
    unixSockets: [...reach.workRoots, reach.sessionTmp],
  };
}

// ════════════════════════════════════════════════════════════
// 凭据
// ════════════════════════════════════════════════════════════

/**
 * 凭据的品牌：只有触及插件构造的凭据带它（不可枚举，展开复制出来的对象不带），存储网关与沙箱据此把不带它的对象当作没有凭据。
 * 它防的是漏传、误传：第一方包由架构守卫禁止拼凭据，插件是可信代码，进程内蓄意伪造挡不住。登记在全局符号表里，
 * 进程里装了两份本包时也认得
 */
export const REACH_CREDENTIAL: unique symbol = Symbol.for('@aalis/api-reach/credential');

/** require 的结果：拒绝时 message 是回给模型的话（被哪条规则拦下、能不能申请、能申请时的最窄目标） */
export type ReachVerdict = { readonly allowed: true } | { readonly allowed: false; readonly message: string };

/**
 * 触及凭据：按一次工具调用签发，只由触及插件构造；工具从调用上下文取得后转交给存储与沙箱。exec、home、paper、tainted
 * 按签发时的触及；require、allows、sandboxPolicy 与 noteWrite 每次按会话当时的设置与污点重算，降档与受污染立即生效
 */
export interface ReachCredential {
  readonly [REACH_CREDENTIAL]: true;
  /** 这个会话读进过谁的内容（来源称呼），执行面闸据它给确认卡写来源；没有即干净。全权档不带：全权不提示 */
  readonly tainted?: readonly string[];
  /** 命令在哪执行；none 即这次调用没有本地效果 */
  readonly exec: 'none' | 'sandbox' | 'host';
  /** 场所的主目录与白纸：当前目录没有值时取 home，不写输出位置的工具写进 paper；没有本地效果时不带 */
  readonly home?: string;
  readonly paper?: string;
  /** 判一个模型给的目标，要问时经审批服务问；批准过的记作这次调用的一次性目标 */
  require(request: ReachRequest): Promise<ReachVerdict>;
  /** 存储兜底：同步判一个真实路径能不能读写，含这次调用批准过的一次性目标 */
  allows(effect: 'read' | 'write', realPath: string): boolean;
  /**
   * 这条命令的沙箱策略，带上这次调用批准过的提权：范围外写并进可写的根（其下的落点照样拒写），按落点批准的只放回那一个
   * 确切路径；只在 exec 为 sandbox 时可取
   */
  sandboxPolicy(): SandboxPolicy;
  /**
   * 子进程环境：取自 owner 的 login shell（在场所的主目录下取一次），沙箱内去掉凭据类变量并注入沙箱要的几项，宿主执行用完整的。
   * 没有本地效果的凭据抛错
   */
  processEnv(mode: 'sandbox' | 'host'): Promise<Record<string, string>>;
  /** 经凭据写进白纸时调用：受污染回合的写入记进来源账本 */
  noteWrite(realPath: string): void;
}

/** 带品牌符号的对象才是凭据 */
export function isReachCredential(value: unknown): value is ReachCredential {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[REACH_CREDENTIAL] === true;
}

// ════════════════════════════════════════════════════════════
// 服务
// ════════════════════════════════════════════════════════════

/** 来源账本的一条：受污染的会话经凭据写进白纸的文件 */
export interface ProvenanceRecord {
  /** 写入它的会话 */
  readonly sessionId: string;
  /** 写入时这个会话读进过谁的内容 */
  readonly sources: readonly string[];
  readonly at: number;
}

export interface ReachService {
  /**
   * 按一次工具调用签发凭据：发起类别取权限服务的 originOf，会话与绑定取会话管理里的记录。没有本地效果的调用拿到
   * exec 为 none 的凭据
   */
  forCall(call: OriginTurn): Promise<ReachCredential>;
  /** 记下这个会话读进了别人写的内容（来源称呼，至少一个）：粘在会话上，之后签发的凭据都带着 */
  markTainted(sessionId: string, sources: readonly string[]): void;
  /** 白纸里一个文件（真实路径）在来源账本里的记录；没有记录的文件按 owner 写的算 */
  provenanceOf(realPath: string): ProvenanceRecord | undefined;
}

/** 调用型服务：绑定接口是 ServiceRef */
export const reach = defineService<ReachService>('reach');

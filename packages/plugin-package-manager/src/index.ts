import type { AppService, Context } from '@aalis/core';
import { createProcessGateway, type ExecResult, type ProcessService } from '@aalis/plugin-process-api';
import { isRegistryDep, isUpgrade } from '@aalis/util-dep-spec';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-package-manager';
export const displayName = '包管理器';
export const subsystem = 'system';
export const provides = ['package-manager'];
export const inject = {
  required: ['process'],
};

// ===== 服务接口 =====

/**
 * 包管理服务：从 npm 安装/卸载插件到 packages/ 目录
 *
 * 通过 `ctx.getService<PackageManagerService>('package-manager')` 消费。
 *
 * 这些操作涉及子进程（npm/tar/pnpm/rm），不属于 core 内核职责，
 * 因此从 App 抽出到独立插件；底层子进程统一走 plugin-process-api。
 */
export interface PackageManagerService {
  /** 从 npm 安装插件到 packages/ 并触发 rescanPlugins */
  install(npmPkg: string): Promise<{ ok: boolean; message: string }>;
  /** 停用并删除 packages/ 下对应目录 */
  uninstall(pluginName: string): Promise<{ ok: boolean; message: string }>;
  /**
   * 批量更新到指定版本，随后重启进程接管。
   *
   * **必须整批提交**，不能每个包各调一次：
   * - peer 冲突只有对整张版本映射一次预检才能发现（A@new 要 core>=0.10、B@new 要
   *   core<0.10，逐个预检各自都过，一起装才冲突）；
   * - 更新是文件系统操作而进程只在启动那一刻读文件系统，所以重启次数恒为 1，
   *   与改了多少个包无关。逐个更新 = 重启 N 次，且中间态是半新半旧。
   *
   * 返回 `ok: true` 表示已提交安装并即将重启——此时 HTTP 响应要抢在进程退出前发出。
   */
  update(targets: UpdateTarget[]): Promise<UpdateResult>;
}

/** 一个待更新目标：包名 + 目标版本（不带范围符，由调用方从市场卡片取 npm latest）。 */
export interface UpdateTarget {
  name: string;
  version: string;
}

export interface UpdateResult {
  ok: boolean;
  message: string;
  /** 预检失败时的逐条冲突说明（npm dry-run 的报告摘要），供前端直接展示。 */
  conflicts?: string[];
  /** 本次是否会重启进程。ok 且 restarting 时前端应进入「等待重连」状态。 */
  restarting?: boolean;
}

// ===== 实现 =====

/**
 * 解析 `npm pack --json` 的输出 → 产物 {filename, name}。
 * npm pack --json 输出形如 `[{"filename":"scope-foo-1.2.3.tgz","name":"@scope/foo",...}]`。
 * 部分 npm 版本会在 JSON 前混入 notice，故定位首个 `[` 起截取。纯函数，便于单测。
 */
export function parsePackInfo(jsonOut: string): { filename: string; name: string } | undefined {
  try {
    const start = jsonOut.indexOf('[');
    if (start < 0) return undefined;
    const arr = JSON.parse(jsonOut.slice(start)) as Array<{ filename?: string; name?: string }>;
    const first = arr?.[0];
    if (!first?.filename || !first?.name) return undefined;
    return { filename: first.filename, name: first.name };
  } catch {
    return undefined;
  }
}

/** 短命令（mkdir/tar/rm/test/npm pack）的超时。 */
const QUICK_TIMEOUT_MS = 120_000;
/**
 * 安装类命令的超时。`npm install` 要装全依赖树 + 原生编译（better-sqlite3、puppeteer
 * 都在脚手架默认依赖里），快机快网下已达 95 秒量级，而超时行为是 SIGKILL——留足余量，
 * 否则会在半装状态下被杀。
 */
const INSTALL_TIMEOUT_MS = 600_000;

async function execProc(
  proc: ProcessService,
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number = QUICK_TIMEOUT_MS,
): Promise<string> {
  return (await execProcBoth(proc, cmd, args, cwd, timeout)).stdout;
}

/** 同 {@link execProc}，但同时给出 stderr——npm 的诊断（含 peer 告警）都写在 stderr。 */
async function execProcBoth(
  proc: ProcessService,
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number = QUICK_TIMEOUT_MS,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result: ExecResult = await proc.execFile(cmd, args, {
      cwd,
      timeout,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    return { stdout: result.stdout, stderr: result.stderr ?? '' };
  } catch (err) {
    const withResult = err as { result?: ExecResult } & Error;
    const stderr = withResult.result?.stderr ?? '';
    throw new Error(stderr || withResult.message);
  }
}

/**
 * 部署形态。两者的安装语义完全不同，装错地方 = 装了不加载。
 *
 * - `workspace`：本仓库式自托管。包落 `packages/<dir>`，由 `createFsPluginLoader` 扫描；
 *   根依赖用 `workspace:` 协议。
 * - `standalone`：`create-aalis` 产出的脚手架（**第一等公民**）。包落 `node_modules/`，
 *   由 `createNodeModulesPluginLoader` **只读根 `dependencies`** 发现；不写
 *   `pnpm-workspace.yaml`、不建 `packages/`。
 */
export type ProjectLayout = 'workspace' | 'standalone';

/**
 * 判别形态：`pnpm-workspace.yaml` 是工作区的权威标志——脚手架产出物只有
 * package.json / index.mjs / aalis.config.yaml / .env.example / .gitignore / README.md
 * 六个文件，不含它。
 */
export function layoutFromWorkspaceFile(hasWorkspaceFile: boolean): ProjectLayout {
  return hasWorkspaceFile ? 'workspace' : 'standalone';
}

/**
 * 根依赖里是否含 `workspace:` 协议。
 *
 * 这是 standalone 分支跑 `npm install` 前的**硬护栏**：npm 遇到该协议会
 * `EUNSUPPORTEDPROTOCOL` 硬失败；但若哪天根依赖恰好没有该协议，`npm install` 会在
 * pnpm 仓库根写出 `package-lock.json` 与扁平 `node_modules`，把整个工作区搅坏。
 * 故不能指望 npm 兜底，必须自己先判。纯函数，便于单测。
 */
export function hasWorkspaceProtocol(pkgJson: Record<string, unknown> | undefined): boolean {
  if (!pkgJson) return false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = pkgJson[field];
    if (!block || typeof block !== 'object') continue;
    for (const v of Object.values(block as Record<string, unknown>)) {
      if (typeof v === 'string' && v.startsWith('workspace:')) return true;
    }
  }
  return false;
}

/**
 * 包是否声明自己是可加载插件（与两个加载器同一判据：纯 `aalis-plugin` 关键词正向门）。
 *
 * 用途是把「装完没发现新插件」分成两种情形：目标本就不是插件（如 `aalis-interface`
 * 前端包）→ 正常；目标声明了自己是插件却没被发现 → **静默假成功**，必须报失败。
 * 纯函数，便于单测。
 */
export function declaresPlugin(pkgJson: Record<string, unknown> | undefined): boolean {
  const kw = pkgJson?.keywords;
  return Array.isArray(kw) && kw.includes('aalis-plugin');
}

function createService(ctx: Context, config: Record<string, unknown>): PackageManagerService {
  const log = ctx.logger;
  const proc = createProcessGateway(ctx);

  function getApp(): AppService {
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('app 服务不可用，无法执行包管理操作');
    return app;
  }

  /** 把配置里的相对/绝对路径归一成绝对路径；未配置则用 fallback。 */
  function resolveConfigured(key: 'packagesDir' | 'projectRoot', fallback: string): string {
    const override = (config as Record<string, unknown>)[key];
    if (typeof override === 'string' && override.length > 0) {
      return override.startsWith('/') ? override : `${process.cwd()}/${override.replace(/^\.?\/+/, '')}`;
    }
    return fallback;
  }

  /**
   * 真实插件目录的绝对路径（仅 workspace 形态用到）。
   *
   * 必须与 core 的 createFsPluginLoader 一致——后者扫描 `<cwd>/packages`。
   * 关键：**不能**走 storage 的 `workspace:` 根（那是 agent 沙盒 `<cwd>/workspace`，
   * 与插件目录 `<cwd>/packages` 不是同一处），否则装到/找错地方（历史 bug：
   * 卸载报"目录不存在"）。可用插件配置 `packagesDir` 覆盖（相对 cwd 或绝对路径）。
   */
  function packagesDir(): string {
    return resolveConfigured('packagesDir', `${process.cwd()}/packages`);
  }

  function projectRoot(): string {
    return resolveConfigured('projectRoot', process.cwd());
  }

  return createPackageManager({
    proc,
    log,
    packagesDir,
    // 项目根：默认 cwd，与 createNodeModulesPluginLoader(projectDir = process.cwd()) 的
    // 默认值及 packagesDir() 的基准同源——三者必须指同一处，否则「我们写的 package.json」
    // 与「加载器读的 package.json」是两份，装了永远不加载。
    // 宿主若给 startAalis 传了非 cwd 的 projectDir（公开选项），必须用本配置项对齐。
    projectRoot,
    // 经 process 网关的 readExternalFile 读，而非 node:fs：目标（项目根 package.json、
    // lockfile、node_modules/<pkg>/package.json）在 storage 沙盒之外，而 readExternalFile
    // 正是文档给这一场景指定的「OS 直通读外部路径」通道——本插件也不在 biome 的 node:* 例外清单里。
    readText: async absPath => {
      try {
        return new TextDecoder().decode(await proc.readExternalFile(absPath));
      } catch {
        return undefined;
      }
    },
    rescanPlugins: () => getApp().rescanPlugins(),
    // 判据取运行时注册表而非 rescan 返回值（理由见 PackageManagerDeps.isPluginRegistered）。
    // plugins 服务缺席时保守返回 false——宁可让「声明为插件却没加载」的诊断多报一次，
    // 也不要在真没装上时谎报成功。
    isPluginRegistered: name =>
      ctx
        .getService<{ getStatus(): Array<{ name: string }> }>('plugins')
        ?.getStatus()
        .some(p => p.name === name) ?? false,
    // 重启并交付回滚凭据。core 只透传 rollback（不解释形状），由 runtime 的重启策略
    // 在「新实例 ready 前夭折」时消费——触发者与执行者同为父进程，全程内存不落盘。
    restartApp: rollback => getApp().restart({ rollback }),
    // 彻底卸载：dispose 上下文并从注册表移除（plugins 服务缺席则 no-op）。
    // 区别于 disablePlugin（仅置禁用态，仍滞留在插件列表里）。
    unloadPlugin: async name => {
      const pm = ctx.getService<{ unload(n: string): Promise<void> }>('plugins');
      if (pm) await pm.unload(name);
    },
    // 卸载后清残留配置：删 plugins.<name> 配置块 + 从 disabledPlugins 移除
    // （否则重装会被"上次禁用"标记带成已禁用状态），并持久化。
    cleanupConfig: name => {
      ctx.config.removePluginConfig(name);
      ctx.config.setPluginEnabled(name, true);
      ctx.config.save();
    },
  });
}

/** install/uninstall 的显式依赖（从 ctx/网关解耦，便于集成测试） */
export interface PackageManagerDeps {
  proc: ProcessService;
  log: { info(msg: string): void; error(msg: string): void };
  /** 真实插件目录绝对路径（= `<cwd>/packages`，与 FS 加载器一致）。仅 workspace 形态用到。 */
  packagesDir(): string;
  /** 项目根绝对路径（= `<cwd>`）：形态探测、根 package.json 读取、npm 的 cwd。 */
  projectRoot(): string;
  /** 读文本文件；不存在或读失败返回 undefined。注入以便单测。 */
  readText(absPath: string): Promise<string | undefined>;
  rescanPlugins(): Promise<string[]>;
  /**
   * 目标插件此刻是否已在运行时注册表里。
   *
   * 这是判定「本次安装是否就位」的**唯一正确判据**。不能用 `rescanPlugins()` 的返回值：
   * 它是全局副作用的产物——core 的 rescan 对已注册插件直接跳过，返回的是「本次扫描新
   * 加载的**全部**插件」，与本次目标无对应关系。用它会在两个场景下给出错误结论：
   * 重装已注册插件时恒返回空（误报失败）；两个安装并发时先跑完的那个会把对方的战果
   * 一并算作自己的（谎报），后跑的则拿到空数组（误报失败）。
   */
  isPluginRegistered(name: string): boolean;
  /** 彻底卸载插件（dispose + 从注册表移除）。plugins 服务缺席则 no-op。 */
  unloadPlugin(name: string): Promise<void>;
  /** 卸载后清理残留配置（删配置块 + 解除禁用标记 + 持久化）。可选：缺省则不清理。 */
  cleanupConfig?(name: string): void;
  /** 重启进程并交付回滚凭据（新实例起不来时由重启策略消费）。缺省则 update 不可用。 */
  restartApp?(rollback: {
    reason: string;
    /** `deleteIfEmpty` 表示该文件更新前并不存在，回滚时应删除而非写空（见 runtime 的 RestartRollback）。 */
    restore: Array<{ path: string; content: string; deleteIfEmpty?: boolean }>;
    postRestore?: { cmd: string; args: string[]; cwd: string };
  }): void;
}

/** `@scope/foo@1.2.3` → `@scope/foo`（剥掉版本后缀，保留 scope）。 */
export function stripVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * 合法 npm 包名（可选 scope），**不含**版本后缀。
 *
 * 首字符锚死字母数字：npm 会把 `-` 开头的 token 当命令行标志，把 `.` / `..` / `./x`
 * 当本地目录 spec（`foo@.` 能让 npm 转去打包宿主工作目录并执行其 prepack 脚本）。
 * 版本段单独用 {@link isSafeVersion} 校验，两段各自锚住首字符才封得死。
 */
const PKG_NAME_ONLY_RE = /^(@[a-z0-9][a-z0-9\-_.]*\/)?[a-z0-9][a-z0-9\-_.]*$/i;
/** 精确版本号：只收字母数字打头、不含路径与标志字符的形态。 */
const VERSION_RE = /^[a-z0-9][a-z0-9.\-+]*$/i;

/**
 * 读 npm 的隐藏锁 `node_modules/.package-lock.json`，得到「此刻树上装的是哪些版本」。
 *
 * 这是 npm 自己维护的、对**实际 node_modules 树**的记录，比 package.json 的范围声明精确，
 * 也比逐个读 `node_modules/<name>/package.json` 便宜（一次读盘拿全树）。
 *
 * 只取顶层条目（`node_modules/<name>`）：嵌套安装（`node_modules/a/node_modules/b`）的 b 与
 * 顶层的 b 不是一回事，把它按裸名钉在顶层会装错位置。
 *
 * 文件不存在（pnpm/yarn 装的工程，它们不写这个文件）或坏 JSON 时返回空 Map，调用方退化为
 * 「只钉被点名的包」——不如全树精确，但不会更糟。
 */
async function readInstalledTree(
  deps: Pick<PackageManagerDeps, 'readText'>,
  root: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const text = await deps.readText(`${root}/node_modules/.package-lock.json`);
  if (text === undefined) return out;
  try {
    const parsed = JSON.parse(text) as { packages?: Record<string, { version?: unknown }> };
    for (const [path, entry] of Object.entries(parsed.packages ?? {})) {
      if (!path.startsWith('node_modules/')) continue;
      const name = path.slice('node_modules/'.length);
      if (name.includes('/node_modules/')) continue; // 嵌套安装，不是顶层那一份
      if (typeof entry?.version === 'string') out.set(name, entry.version);
    }
  } catch {
    /* 坏 JSON：当作读不到 */
  }
  return out;
}

/**
 * 一批更新目标拼成 argv 后允许的总字节数。
 *
 * 约束的来源是 `execve(2)` 的 `ARG_MAX`：exec 要把 argv 与 envp 从旧地址空间复制到新地址
 * 空间，内核必须在拆掉旧映像前把这些字节暂存下来，故这块缓冲有界——否则任何非特权进程
 * 都能靠 execve 让内核任意分配内存。实测本机 `kern.argmax` = 1048576（macOS）；Linux 自
 * 2.6.23 起改为跟 `RLIMIT_STACK/4` 挂钩，默认 8MB 栈 → 约 2MiB，故 1MiB 是跨平台的下界。
 *
 * **按字节而不是按包数**：包名长度差着数量级（`ms@2.0.0` 8 字节 vs
 * `@aalis/plugin-session-manager-api@0.9.1` 38 字节），拿个数近似字节等于用一个与约束无关的
 * 量设闸——曾经这里是「最多 50 个包」，比真实约束低了约 600 倍，把本仓 99 个包的协调发版
 * 场景直接挡死。
 *
 * 128 KiB 只占 ARG_MAX 的 1/8，余下留给 envp（它与 argv 共享同一预算）与 npm 的固定参数；
 * 按最长的 @aalis 包名算仍容得下三千余个包，任何真实实例都够不到。
 */
const SPEC_ARGV_BUDGET = 128 * 1024;

/**
 * 校验一批更新目标，产出可直接交给 npm 的 `name@version` spec。
 *
 * 拒绝而非净化：这些值最终作为独立 argv 交给 npm，任何一条可疑就整批停下，
 * 不猜用户意图。纯函数，便于单测。
 */
export function buildUpdateSpecs(targets: readonly UpdateTarget[]): { specs?: string[]; error?: string } {
  if (!Array.isArray(targets) || targets.length === 0) return { error: '未指定更新目标' };
  const specs: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const t of targets) {
    const name = typeof t?.name === 'string' ? t.name : '';
    const version = typeof t?.version === 'string' ? t.version : '';
    if (!PKG_NAME_ONLY_RE.test(name)) return { error: `非法包名: ${JSON.stringify(name)}` };
    if (!VERSION_RE.test(version)) return { error: `非法版本号: ${name}@${JSON.stringify(version)}` };
    // 同名多版本会让 npm 取最后一个，静默丢弃前面的选择——宁可让用户重选。
    if (seen.has(name)) return { error: `同一包被指定了多次: ${name}` };
    seen.add(name);
    const spec = `${name}@${version}`;
    // 按**字节**计而非按个数：这些 spec 逐条成为 argv，而 execve 的约束是参数块的总字节数，
    // 与包数无关（`ms@2.0.0` 8 字节，`@aalis/plugin-session-manager-api@0.9.1` 38 字节）。
    // 超限即整批停下，与本函数其余校验同一策略：不猜、不截断。
    bytes += Buffer.byteLength(spec) + 1; // +1 = argv 之间的 NUL 分隔
    if (bytes > SPEC_ARGV_BUDGET) {
      return { error: `更新目标过多：参数总长已超 ${SPEC_ARGV_BUDGET} 字节，请分批提交` };
    }
    specs.push(spec);
  }
  return { specs };
}

/**
 * 从 npm 的失败输出里摘出冲突要点，供前端直接展示。纯函数，便于单测。
 */
export function extractPeerConflicts(output: string): string[] {
  const lines = output.split('\n');
  const picked = lines.filter(l => /ERESOLVE|peer |Conflicting peer|Found:|Could not resolve/i.test(l));
  return picked.map(l => l.replace(/^npm (ERR!|error|warn)\s*/i, '').trim()).filter(l => l.length > 0);
}

/**
 * 从 **成功**（exit 0）的 dry-run 输出里找出因本次目标而无法满足的 peer 依赖。
 *
 * 为什么不能只靠退出码——已实测（npm 10.9.2）：
 * - 「装一个新包、其 peer 不满足」→ npm 本就 exit 1，`--strict-peer-deps` 无增量价值；
 * - 「**改一个已被别人 peer 依赖的包的版本**」（正是更新 core 的形状）→ npm 把命令行上
 *   显式指定的 spec 当作用户意图，**只打 warn 且 exit 0**，`--strict-peer-deps` 同样不生效，
 *   把目标版本先写进 package.json 再裸装也一样。
 *
 * 而它确实会在 stderr 打出 `peer <name>@"<range>" from <dependent>`。只认**提到本次目标**
 * 的那些行：工程里原有的、与本次无关的未满足 peer 不该阻断更新。
 */
export function findUnmetPeers(output: string, targetNames: readonly string[]): string[] {
  const names = new Set(targetNames);
  // npm 会把同一条 peer 冲突在不同上下文里重复打印，去重后再给用户。
  const out = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.replace(/^npm (ERR!|error|warn)\s*/i, '').trim();
    const m = /^peer\s+(\S+?)@"([^"]+)"\s+from\s+(.+)$/.exec(line);
    if (!m) continue;
    if (!names.has(m[1])) continue;
    out.add(`${m[3]} 需要 ${m[1]}@${m[2]}`);
  }
  return [...out];
}

/**
 * 包管理核心：install/uninstall 的纯依赖实现（不碰 ctx/网关，可单测）。
 * 所有文件操作走 process 网关（子进程：npm/tar/mkdir/rm/test），目标是真实
 * `<cwd>/packages`——不经 storage 沙盒（沙盒根是 workspace，够不到 packages）。
 * ctx 组装层见 createService。
 */
export function createPackageManager(deps: PackageManagerDeps): PackageManagerService {
  const { proc, log } = deps;

  /**
   * 当前占用的操作描述；`null` = 空闲。
   *
   * install / uninstall / update 三者都会改**同一个**根 `package.json`，而 npm 的写法是
   * 「读整份 → 改内存 → 整份写回」。并行时是经典的丢失更新：A 与 B 各自读到同一份旧内容，
   * 后写者整份覆盖，先写者新增的那条依赖消失——包的文件却已经落进 node_modules。而
   * `createNodeModulesPluginLoader` **只遍历根依赖的键、从不扫 node_modules 目录**，
   * 于是那个包永远不会被加载：装成功了，重启后插件不见了，用户无从判断。
   *
   * 锁必须在**服务层**：本服务经 `ctx.provide` 公开，任何插件都能绕过 HTTP 路由直接调，
   * 加在路由或前端都不算数。
   */
  let inflight: string | null = null;
  /**
   * 进程即将重启（update 成功后置位），此后**永不释放**锁。
   *
   * 重启不是立刻发生的（延迟 500ms + stop + spawn），这段窗口里若放新操作进来，
   * 它会被 `process.exit` 腰斩在半路，留下半装状态。
   */
  let terminal = false;

  /**
   * 串行闸：占用中直接**拒绝**而非排队。
   *
   * 拒绝而非排队的决定性理由：update 成功后进程立即重启，排在它后面的操作必然被腰斩。
   * 排队在这里是错的语义——「一次一个」才是这三个操作的真实约束，只是此前没人强制它。
   */
  async function exclusive<T extends { ok: boolean; message: string }>(
    what: string,
    run: () => Promise<T>,
  ): Promise<T> {
    if (inflight) {
      return { ok: false, message: `有包管理操作正在进行中（${inflight}），请稍候重试` } as T;
    }
    inflight = what;
    try {
      return await run();
    } finally {
      if (!terminal) inflight = null;
    }
  }

  /** 路径存在性：`test -d|-f <abs>`（不存在 → exit 1 → 抛 → false）。绝对路径，cwd 无关。 */
  async function pathExists(absPath: string, kind: 'd' | 'f'): Promise<boolean> {
    try {
      await proc.execFile('test', [`-${kind}`, absPath], { cwd: process.cwd(), timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** 读 JSON；不存在或解析失败一律 undefined（调用方按「读不到」处理，不区分原因）。 */
  async function readJson(absPath: string): Promise<Record<string, unknown> | undefined> {
    const text = await deps.readText(absPath);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  async function detectLayout(): Promise<ProjectLayout> {
    return layoutFromWorkspaceFile(await pathExists(`${deps.projectRoot()}/pnpm-workspace.yaml`, 'f'));
  }

  /**
   * 装完的统一判定：rescan 出新插件即成功；没出新插件时按目标是否**声明自己是插件**分流。
   * 「声明了插件却没被发现」正是那条静默假成功——必须报失败，否则用户看到 ok 却什么也没装上。
   */
  async function settleInstall(
    npmPkg: string,
    installedPkgJsonPath: string,
    where: string,
  ): Promise<{ ok: boolean; message: string }> {
    const target = stripVersion(npmPkg);
    // rescan 只当副作用用（让加载器发现新包），**不看返回值**——判据是目标自身是否就位。
    await deps.rescanPlugins();
    if (deps.isPluginRegistered(target)) return { ok: true, message: `已安装并加载: ${target}` };
    const meta = await readJson(installedPkgJsonPath);
    if (declaresPlugin(meta)) {
      return { ok: false, message: `已装到 ${where}，但它声明为插件却未被加载——请检查其 keywords 与入口导出` };
    }
    return { ok: true, message: `已安装 ${target}（非插件包，不进入插件列表）` };
  }

  /** standalone：写根 `dependencies`——这是 node_modules 加载器**唯一**的发现来源。 */
  async function installStandalone(npmPkg: string): Promise<{ ok: boolean; message: string }> {
    const root = deps.projectRoot();
    const rootPkg = await readJson(`${root}/package.json`);
    if (hasWorkspaceProtocol(rootPkg)) {
      return {
        ok: false,
        message: '根依赖含 workspace: 协议，拒绝在此运行 npm install（会写出 package-lock.json 并搅坏 pnpm 工作区）',
      };
    }
    log.info(`正在安装: ${npmPkg} → 根依赖 + node_modules`);
    await execProc(proc, 'npm', ['install', npmPkg, '--no-audit', '--no-fund'], root, INSTALL_TIMEOUT_MS);
    const bare = stripVersion(npmPkg);
    return settleInstall(npmPkg, `${root}/node_modules/${bare}/package.json`, 'node_modules');
  }

  /** workspace：解包到 `packages/<dir>` 再 `pnpm install --filter` 链接（本仓库自托管形态）。 */
  async function installWorkspace(npmPkg: string): Promise<{ ok: boolean; message: string }> {
    const packagesDir = deps.packagesDir();
    // 分离包名与可选版本：@scope/foo@1.2.3 → dirName=foo（去 scope、去版本）
    const dirName = npmPkg.replace(/^@[^/]+\//, '').replace(/@[^@]+$/, '');
    const targetDir = `${packagesDir}/${dirName}`;

    if (await pathExists(targetDir, 'd')) return { ok: false, message: `目录 ${dirName} 已存在` };
    log.info(`正在安装插件: ${npmPkg} → packages/${dirName}`);

    let tgzPath: string | undefined;
    try {
      await execProc(proc, 'mkdir', ['-p', packagesDir], process.cwd()); // 确保 packages/ 存在
      // npm pack --json 精确返回产物 {filename, name}，避免 includes 误匹配
      // （装 foo 时命中 foo-bar-*.tgz）；name 是精确包名，供 pnpm --filter 用。
      const packOut = await execProc(
        proc,
        'npm',
        ['pack', npmPkg, '--pack-destination', packagesDir, '--json'],
        process.cwd(),
      );
      const packInfo = parsePackInfo(packOut);
      if (!packInfo) return { ok: false, message: '下载包失败: 未能解析 npm pack 产物' };
      tgzPath = `${packagesDir}/${packInfo.filename}`;
      await execProc(proc, 'mkdir', ['-p', targetDir], process.cwd());
      await execProc(proc, 'tar', ['xzf', tgzPath, '-C', targetDir, '--strip-components=1'], process.cwd());
      await execProc(proc, 'rm', ['-f', tgzPath], process.cwd()); // 清理 tgz
      tgzPath = undefined; // 已删，回滚时不再尝试
      // --filter 用精确包名（npm pack 回报的 name，无版本后缀）链接新 workspace 包
      await execProc(proc, 'pnpm', ['install', '--filter', packInfo.name], process.cwd(), INSTALL_TIMEOUT_MS);

      return await settleInstall(npmPkg, `${targetDir}/package.json`, `packages/${dirName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`安装插件 "${npmPkg}" 失败: ${message}`);
      // 回滚：清理半成品 targetDir 与残留 tgz，避免占位导致下次"目录已存在"
      await execProc(proc, 'rm', ['-rf', targetDir], process.cwd()).catch(() => {});
      if (tgzPath) await execProc(proc, 'rm', ['-f', tgzPath], process.cwd()).catch(() => {});
      return { ok: false, message };
    }
  }

  /**
   * 在**项目副本**里预检整组目标版本；返回冲突要点，`undefined` = 通过。
   *
   * 为什么必须隔离到副本，而不是在 live tree 上跑 `--dry-run`（实测 npm 10.9.2）：
   * 1. `--dry-run` **有副作用**——它不碰 `package.json` 与 `package-lock.json`，却会把
   *    `node_modules/.package-lock.json`（npm 的隐藏 lockfile）重写成「目标版本已装」。
   *    紧接着的真装读到它就判定树已就绪，直接 `up to date` 什么都不做：于是声明成了新版、
   *    node_modules 里仍是旧代码，而旧代码起得来 → 重启成功 → 回滚永不触发 → 整次更新
   *    空转却报成功。副本里跑则 live tree 分毫未动，无需事后补救。
   * 2. 用户 `.npmrc` 里的 `legacy-peer-deps=true`（React 生态常见 workaround）会让 npm
   *    **完全不报** peer 告警，唯一的护栏静默失效。副本在项目树之外，天然不继承项目级
   *    配置；再用 `npm_config_legacy_peer_deps=false` 压掉用户级与全局配置（已实测：
   *    即便副本里放了 `legacy-peer-deps=true` 的 `.npmrc`，该环境变量也能翻回来）。
   *
   * 判据只能是解析告警文本：`--dry-run --json` 实测只给 `{added, removed, changed,
   * audited, funding}`，无任何冲突信息；退出码在本场景恒为 0（npm 把命令行显式 spec
   * 视为用户意图，只 warn 就放行），`--strict-peer-deps` 在副本里同样不改变这一点，
   * 故不再传它——留着只会让人误以为有额外保障。
   */
  async function preflightInSandbox(specs: string[], root: string): Promise<string[] | undefined> {
    const tmp = await proc.makeTempDir('preflight');
    try {
      // 直接 cp 现有文件，不重新写内容——与本插件其余文件操作同一路子（走 proc 网关的
      // POSIX 命令），也省掉一个只为此处存在的写原语。
      await execProc(proc, 'cp', [`${root}/package.json`, `${tmp.path}/package.json`], tmp.path);
      const lock = `${root}/package-lock.json`;
      if (await pathExists(lock, 'f')) {
        await execProc(proc, 'cp', [lock, `${tmp.path}/package-lock.json`], tmp.path);
      }
      const { stdout, stderr } = await execProcBoth(
        proc,
        'npm',
        ['install', ...specs, '--dry-run', '--no-audit', '--no-fund'],
        tmp.path,
        INSTALL_TIMEOUT_MS,
        { npm_config_legacy_peer_deps: 'false' },
      );
      const unmet = findUnmetPeers(`${stderr}\n${stdout}`, specs.map(stripVersion));
      return unmet.length > 0 ? unmet : undefined;
    } catch (err) {
      // 非零退出 = npm 自己判定无解（ERESOLVE 等）。原样上报，不猜。
      const raw = err instanceof Error ? err.message : String(err);
      const conflicts = extractPeerConflicts(raw);
      return conflicts.length > 0 ? conflicts : [raw.slice(0, 2000)];
    } finally {
      await tmp.cleanup().catch(() => {});
    }
  }

  /**
   * 批量更新。形状是「一次算全量 → 整组预检 → 一次 install → 一次重启」，
   * 重启次数恒为 1，与改了多少个包无关（语义见 {@link PackageManagerService.update}）。
   */
  async function updateAll(targets: UpdateTarget[]): Promise<UpdateResult> {
    const { specs, error } = buildUpdateSpecs(targets);
    if (!specs) return { ok: false, message: error ?? '参数非法' };
    if (!deps.restartApp) return { ok: false, message: '当前宿主未提供重启能力，无法完成更新' };

    const root = deps.projectRoot();
    if ((await detectLayout()) === 'workspace') {
      // 工作区形态的包是 workspace: 协议的本地包，不从 npm 取版本——升级走 git。
      return { ok: false, message: '工作区（monorepo）形态不支持市场更新：包来自本地 packages/，请用 git 升级' };
    }
    const rootPkgPath = `${root}/package.json`;
    const rootPkgText = await deps.readText(rootPkgPath);
    if (rootPkgText === undefined) return { ok: false, message: `读不到根 package.json: ${rootPkgPath}` };
    const rootPkg = await readJson(rootPkgPath);
    if (hasWorkspaceProtocol(rootPkg)) {
      return { ok: false, message: '根依赖含 workspace: 协议，拒绝在此运行 npm install' };
    }
    // 只允许更新「根依赖里以 semver 范围声明」的包。闸放在服务层而非 HTTP 路由——
    // 本服务经 ctx.provide 公开，任何插件都能绕过路由直接调用（理由见 isRegistryDep）。
    const rootDependencies = (rootPkg?.dependencies ?? {}) as Record<string, string>;
    const notUpdatable = targets.filter(t => !isRegistryDep(rootDependencies[t.name]));
    if (notUpdatable.length > 0) {
      return {
        ok: false,
        message:
          '以下包不在根依赖中（由其它插件带入）或不是 registry 来源，单独更新只会装出第二份副本；' +
          `请改为更新带入它们的插件：${notUpdatable.map(t => t.name).join('、')}`,
      };
    }

    // ── 读取每个目标的当前实装版本 ──
    // 两处都要用：(a) 降级守卫；(b) 回滚凭据钉精确旧版。两者都不能靠根 package.json 的
    // 声明——那是**范围**，回滚时按范围重解析只会又解到刚崩掉的新版。
    const installedVersions = new Map<string, string>();
    for (const t of targets) {
      const text = await deps.readText(`${root}/node_modules/${t.name}/package.json`);
      if (text === undefined) continue;
      try {
        const v = (JSON.parse(text) as { version?: unknown }).version;
        if (typeof v === 'string') installedVersions.set(t.name, v);
      } catch {
        /* 坏 JSON：当作读不到，由下面的守卫拒掉 */
      }
    }

    // ── 降级守卫 ──
    // 闸放在服务层而非 HTTP 路由：本服务经 ctx.provide 公开，任何插件都能绕过路由直接调用。
    // 拒绝而非放行的理由：registry 的 dist-tags.latest 可以**低于**本地已装版本（发布事故后
    // `npm dist-tag add pkg@旧版 latest` 回滚，或用户曾装过预发布版），此时「更新」会静默降级；
    // 读不到已装版本同样拒——无从判断方向就不动，用户可显式卸载重装。
    const notUpgrade = targets.filter(t => !isUpgrade(installedVersions.get(t.name), t.version));
    if (notUpgrade.length > 0) {
      return {
        ok: false,
        message:
          '以下目标版本不高于本地已装版本（或本地版本号读不到），更新会变成降级，已拒绝：' +
          notUpgrade
            .map(t => `${t.name}（本地 ${installedVersions.get(t.name) ?? '未知'} → 目标 ${t.version}）`)
            .join('、'),
      };
    }

    // ── 预检：整组一次，不逐个 ──
    // 逐个预检发现不了「A@new 要 core>=0.10、B@new 要 core<0.10」这类只在合并时冲突的组合。
    log.info(`更新预检: ${specs.join(' ')}`);
    const reject = (conflicts: string[]): UpdateResult => ({
      ok: false,
      message: '依赖预检未通过，未改动任何文件。若是 peer 版本要求，请把被依赖方一并勾选后重试。',
      conflicts,
    });
    const verdict = await preflightInSandbox(specs, root);
    if (verdict) return reject(verdict);

    // ── 快照：预检过了才有必要 ──
    // lockfile 与 package.json 必须一起回退，否则还原后的树是「声明旧版、锁定新版」。
    const restore: Array<{ path: string; content: string; deleteIfEmpty?: boolean }> = [
      { path: rootPkgPath, content: rootPkgText },
    ];
    const lockPath = `${root}/package-lock.json`;
    const lockText = await deps.readText(lockPath);
    if (lockText !== undefined) {
      restore.push({ path: lockPath, content: lockText });
    } else {
      // 原本没有 lockfile（pnpm/yarn 装的工程），而 npm install 会**新建**一个锁到新版。
      // 回滚只能写回文件、不能删除新增文件，留着它会让 postRestore 判定新版仍满足还原后的
      // 范围 → `up to date` → node_modules 纹丝不动。用空内容占位不行（会得到坏 JSON），
      // 故记为「回滚时删掉它」，把工程还原成它原本无锁的样子。
      restore.push({ path: lockPath, content: '', deleteIfEmpty: true });
    }

    // 装之前记下整棵树的实装版本。回滚不能只钉被点名的包：npm 会顺带把**传递依赖**升上去
    // （新版把某个依赖的下界抬高了），而回滚时 `npm install <被点名的包>@<旧版>` 只会
    // `changed 1 package` —— 被顺带升上去的那个仍满足旧版声明的范围，npm 不动它，于是它
    // 永久停在新版。有 lockfile 时不会（还原锁即还原全树），这是**无锁形态专有**的残留。
    //
    // 这条正落在本仓自己的依赖形状上：包间依赖写 `>=<当前版本> <1.0.0`，api 每 bump 一个
    // minor，下一版插件的下界就抬一格 —— plugin@old 要 `>=0.9.0`、plugin@new 要 `>=0.10.0`，
    // 更新把 api 拉到 0.10.0，回滚把插件退回 old，而 0.10.0 仍满足 `>=0.9.0`。若崩溃本来
    // 就是这次 api 升级引起的，回滚等于没做，进程 crash loop 而用户被告知已回滚。
    const treeBefore = await readInstalledTree(deps, root);

    // ── 提交 ──
    // 预检在副本里做，live tree 此刻**未被任何 dry-run 触碰**，可以直接装。
    try {
      await execProc(proc, 'npm', ['install', ...specs, '--no-audit', '--no-fund'], root, INSTALL_TIMEOUT_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`更新安装失败: ${message}`);
      return { ok: false, message: `安装失败（工程未重启，可重试）: ${message}` };
    }

    // ── 重启接管 ──
    // 回滚凭据交给重启策略：只有它能观察到「新实例 ready 前夭折」。插件级失败不在此列
    // ——插件起不来会停在 error 态且 WebUI 可见，自动回滚反而会掩盖问题。
    log.info(`更新完成，正在重启接管: ${specs.join(' ')}`);
    // 置位后锁不再释放：重启是延迟发生的，这段窗口放新操作进来会被 process.exit 腰斩。
    terminal = true;
    // postRestore 钉**精确旧版**，不用裸 `npm install`。
    // 裸 install 只能按还原后的 package.json 重解析，而声明通常是 caret 范围（`^1.0.0`），
    // 刚崩掉的新版（1.1.0）本身就满足它——于是 npm 又把它装回来，node_modules 分毫未变，
    // 而重启策略照样打印「已回滚并重新启动旧版本」。实测：有锁时正常，无锁时静默失效。
    // `--no-save` 保证 package.json 维持 restore 写回的原样，不被 npm 改写成 `^旧版`。
    // 降级守卫已保证每个 target 都有已装版本（读不到的在那里就被拒了），此处的 undefined
    // 过滤只是让类型收窄，不承担逻辑。
    const pinned = targets
      .map(t => {
        const v = installedVersions.get(t.name);
        return v === undefined ? undefined : `${t.name}@${v}`;
      })
      .filter((s): s is string => s !== undefined);
    // 再把「被这次安装顺带改了版本」的包一并钉回旧版（理由见上面 treeBefore 处的注释）。
    // 只回退**本来就在**的包：新增的包钉不回去（它更新前不存在），留给 npm 的 extraneous。
    const named = new Set(targets.map(t => t.name));
    const treeAfter = await readInstalledTree(deps, root);
    for (const [name, before] of treeBefore) {
      if (named.has(name)) continue;
      const after = treeAfter.get(name);
      if (after !== undefined && after !== before) pinned.push(`${name}@${before}`);
    }
    deps.restartApp({
      reason: `marketplace-update:${specs.join(',')}`,
      restore,
      postRestore: { cmd: 'npm', args: ['install', ...pinned, '--no-save', '--no-audit', '--no-fund'], cwd: root },
    });
    return { ok: true, restarting: true, message: `已更新 ${specs.join('、')}，正在重启…` };
  }

  return {
    update: t => exclusive(`更新 ${t.map(x => x.name).join('、')}`, () => updateAll(t)),

    install: npmPkg =>
      exclusive(`安装 ${npmPkg}`, async () => {
        const layout = await detectLayout();
        if (layout === 'workspace') return installWorkspace(npmPkg);
        try {
          return await installStandalone(npmPkg);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`安装 "${npmPkg}" 失败: ${message}`);
          return { ok: false, message };
        }
      }),

    uninstall: pluginName => exclusive(`卸载 ${pluginName}`, () => uninstallOne(pluginName)),
  };

  async function uninstallOne(pluginName: string): Promise<{ ok: boolean; message: string }> {
    {
      const dirName = pluginName.replace(/^@[^/]+\//, '');
      // 安全闸：dirName 必须是合法 npm 包段名——杜绝路径穿越（如 `../../x`）导致
      // `rm -rf packages/../../x` 删到 packages 外的任意目录。
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(dirName)) {
        return { ok: false, message: `非法插件名（疑似路径穿越）: ${pluginName}` };
      }
      const layout = await detectLayout();
      try {
        let detail: string;
        if (layout === 'workspace') {
          const targetDir = `${deps.packagesDir()}/${dirName}`;
          const existed = await pathExists(targetDir, 'd');
          if (existed) await execProc(proc, 'rm', ['-rf', targetDir], process.cwd()); // 删目录，不再回来
          detail = existed ? `已删除 packages/${dirName}` : '目录原不存在，已从运行时移除';
        } else {
          // standalone：必须从根 dependencies 摘掉。只 dispose 运行时实例是不够的——
          // 依赖声明还在，下次启动加载器照样把它发现并装载回来。
          await execProc(
            proc,
            'npm',
            ['uninstall', pluginName, '--no-audit', '--no-fund'],
            deps.projectRoot(),
            INSTALL_TIMEOUT_MS,
          );
          detail = '已从根依赖与 node_modules 移除';
        }
        await deps.unloadPlugin(pluginName); // 从运行时注册表彻底移除（dispose + delete），幂等
        deps.cleanupConfig?.(pluginName); // 清残留配置
        log.info(`${pluginName}: ${detail}`);
        return { ok: true, message: `插件 ${pluginName} 已卸载（${detail}）` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    }
  }
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  ctx.provide('package-manager', createService(ctx, config), {
    label: 'package-manager',
  });
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    'package-manager': PackageManagerService;
  }
}

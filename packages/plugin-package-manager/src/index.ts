import { failureText, unmetDependencies } from '@aalis/api-doctor';
import { hostConfig } from '@aalis/api-host-config';
import { hostPaths } from '@aalis/api-host-paths';
import {
  type InstallResult,
  type PackageManagerService,
  packageManager,
  type UninstallOptions,
  type UpdateResult,
  type UpdateTarget,
} from '@aalis/api-package-manager';
import { declaresPlugin, pluginSource } from '@aalis/api-plugin-source';
import { type ExecResult, type ProcessService, processService } from '@aalis/api-process';
import {
  appService,
  type BoundOf,
  definePlugin,
  lifecycle,
  logger,
  optional,
  type PluginStatusEntry,
  pluginsService,
  provide,
  services,
} from '@aalis/core';
import type { RestartRollback } from '@aalis/runtime';
import { TextError, type TextRef, textClauses, textOf, toSource } from '@aalis/schema-i18n';
import { classifyDepSpec, type DepOrigin, isRegistryDep, isUpgrade } from '@aalis/util-dep-spec';
import { t } from './texts.js';

// ===== 实现 =====

/** 短命令（cp、npm view 等）的超时。 */
const QUICK_TIMEOUT_MS = 120_000;
/**
 * 安装类命令的超时。`npm install` 要装全依赖树并跑依赖的安装脚本（比如 plugin-tool-browser
 * 依赖的 puppeteer 安装时要下载 Chrome），快机快网下已达 95 秒量级，而超时行为是 SIGKILL——留足余量，
 * 否则会在半装状态下被杀。
 */
const INSTALL_TIMEOUT_MS = 600_000;
/**
 * 压掉 `legacy-peer-deps` 的环境变量。用户或项目 `.npmrc` 里的 `legacy-peer-deps=true`（React
 * 生态常见的 workaround）会让 npm 对 peer 不满足**完全不报**，安装与更新预检的 peer 护栏就此
 * 静默失效。环境变量优先于项目根的 `.npmrc`（install-chain 里有真 npm 用例）。
 */
const STRICT_PEERS_ENV = { npm_config_legacy_peer_deps: 'false' };

async function execProc(
  proc: ProcessService,
  cmd: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return (await execProcBoth(proc, cmd, args, cwd, QUICK_TIMEOUT_MS, undefined, signal)).stdout;
}

/** 同 {@link execProc}，但同时给出 stderr——npm 的诊断（含 peer 告警）都写在 stderr。 */
async function execProcBoth(
  proc: ProcessService,
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number = QUICK_TIMEOUT_MS,
  extraEnv: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result: ExecResult = await proc.execFile(cmd, args, {
      cwd,
      timeout,
      signal,
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
 * 包类型是否归市场装卸：插件（判据同 {@link declaresPlugin}）与前端界面（`aalis-interface`）
 * 归市场管，返回 `undefined`；其余按类型关键词返回种类码（没有类型关键词的是 other），拒绝时显示 KIND_NAMES 里的名字。
 * 装与卸共用这一份判据——同一件事维护两份同义判据，正是本仓已出事四次的形态（依赖来源判据、定级数学、包名正则、关键词分类）。
 * 纯函数，便于单测。
 */
export function nonMarketKind(keywords: unknown): 'core' | 'runtime' | 'api' | 'schema' | 'util' | 'other' | undefined {
  const kw: unknown[] = Array.isArray(keywords) ? keywords : [];
  if (declaresPlugin({ keywords: kw }) || kw.includes('aalis-interface')) return undefined;
  if (kw.includes('aalis-core')) return 'core';
  if (kw.includes('aalis-runtime')) return 'runtime';
  if (kw.includes('aalis-api')) return 'api';
  if (kw.includes('aalis-schema')) return 'schema';
  if (kw.includes('aalis-util')) return 'util';
  return 'other';
}

/** 不归市场装卸的包种类给人看的名字 */
const KIND_NAMES: Readonly<Record<NonNullable<ReturnType<typeof nonMarketKind>>, TextRef>> = {
  core: t('kindCore'),
  runtime: t('kindRuntime'),
  api: t('kindApi'),
  schema: t('kindSchema'),
  util: t('kindUtil'),
  other: t('kindOther'),
};

/** 服务依赖者闸读的插件状态：判谁在提供、谁 required 什么，以及 pending 的目标是缺还是在等（api-doctor 的共享判据） */
type ServiceStatus = Pick<PluginStatusEntry, 'name' | 'instanceId' | 'state' | 'error' | 'provides' | 'uses'>;

/**
 * 找出「卸载 target 会断其服务依赖」的插件：target 的某个实例正在提供或马上就提供的某服务 S 没有别的插件正在提供，且有别的
 * 插件 required 依赖 S（uses 里未包 optional）→ 这些插件会被打断。卸载连同 target 的全部实例一起卸下，所以按同名的每个实例判：算在提供的是
 * active、activating，以及 pending 而只是在等的（按 api-doctor 的共享判据不缺什么，它要的在启动，起来就提供）；disabled、
 * error 与 pending 而缺服务的不在提供。别的提供者只算 active 与 activating（替代得是确定的）。已禁用（disabled / disposed）
 * 的依赖者不算。available 是当前有提供者的服务名（services.names()）。纯函数，便于单测。
 */
export function findServiceDependents(
  targetName: string,
  status: ReadonlyArray<ServiceStatus>,
  available: Iterable<string>,
): string[] {
  const providing = (p: Pick<PluginStatusEntry, 'state'>) => p.state === 'active' || p.state === 'activating';
  const unmet = unmetDependencies(status, available);
  const live = status.filter(
    p =>
      p.name === targetName &&
      (providing(p) || (p.state === 'pending' && unmet.get(p.instanceId)?.lacking.length === 0)),
  );
  const dependents = new Set<string>();
  for (const svc of new Set(live.flatMap(p => p.provides ?? []))) {
    const otherProvider = status.some(p => p.name !== targetName && providing(p) && (p.provides ?? []).includes(svc));
    if (otherProvider) continue; // 还有别的提供者在提供，删了不致命
    for (const p of status) {
      if (
        p.name !== targetName &&
        p.state !== 'disabled' &&
        p.state !== 'disposed' &&
        p.uses.some(use => use.kind === 'required' && use.service === svc)
      ) {
        dependents.add(p.name);
      }
    }
  }
  return [...dependents];
}

/**
 * 交给 npm 的 argv 里的包名（可选 scope，不含版本）与版本，spec = 包名(@版本)?。
 *
 * 两段的首字符**都**必须是字母数字。spec 最终作为一个 argv 传给 npm，而 npm 会：
 *   - 把以 `-` 开头的 token 当命令行标志（`--force`、`--ignore-scripts` 都是 npm 上真实存在的可发布包名）；
 *   - 把 `.` / `..` / `./x` 当本地目录 spec —— **`foo@.` 与 `@a/b@..` 同样是目录 spec**，
 *     只锚名段挡不住；实测这条能让 npm 转去打包宿主工作目录并执行其 prepack/prepare 生命周期脚本。
 * 两段各自锚住首字符，即封死目录 spec 与标志注入两条面。版本只含字母数字与 `.` `-` `+`：版本号（可带预发布与
 * 构建元数据）与 dist-tag，`^`、`~`、`>=` 这类带运算符的范围与路径都不收。
 */
const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9\-_.]*\/)?[a-z0-9][a-z0-9\-_.]*$/i;
const VERSION_RE = /^[a-z0-9][a-z0-9.\-+]*$/i;

/**
 * 校验单个包 spec（包名，可带 `@版本`），合法返回 `undefined`、非法返回可读理由。
 *
 * 放在**服务层**：本服务对外公开，任何插件都能绕过 HTTP 路由直接调用。
 * 这与 `buildUpdateSpecs` 是同一条纪律——路由只做「是不是字符串」的形状检查，安全校验
 * 收在所有调用方的必经之路上。argv 面的包名与版本各只有一个正则，装、卸（本函数）与更新（buildUpdateSpecs）共用；
 * URL 路径段另有一份不含版本段的（webui-server 的 depgraph 端点，见那里的注释）——
 * 两者挡的东西不同，不是同一份的拷贝，别再把它们合并成一条。
 * 纯函数，便于单测。
 */
export function validatePackageSpec(spec: unknown): TextRef | undefined {
  if (typeof spec !== 'string' || spec.length === 0) return t('emptyName');
  // 包名里的 @ 只能是开头的 scope：开头之后还有 @，最后一个就是版本的分隔
  const at = spec.lastIndexOf('@');
  const valid =
    at > 0 ? PKG_NAME_RE.test(spec.slice(0, at)) && VERSION_RE.test(spec.slice(at + 1)) : PKG_NAME_RE.test(spec);
  return valid ? undefined : t('badName', { name: JSON.stringify(spec) });
}

// ===== 插件入口 =====

const uses = {
  proc: processService,
  paths: hostPaths,
  lifecycle,
  logger,
  provide,
  services,
  app: appService,
  plugins: pluginsService,
  hostConfig: optional(hostConfig),
  source: optional(pluginSource),
};
type Caps = BoundOf<typeof uses>;

function createService(caps: Caps): PackageManagerService {
  const log = caps.logger.use;
  const proc = caps.proc.use;

  const { settled, ...service } = createPackageManager({
    proc,
    log: log,
    signal: caps.lifecycle.use.signal,
    // 装到宿主的安装集：与插件加载器读的是同一份 package.json，否则装了永远不加载
    projectRoot: () => caps.paths.use.app,
    // 经 process 服务的 readExternalFile 读，而非 node:fs：目标（项目根 package.json、
    // lockfile、node_modules/<pkg>/package.json）在 storage 沙盒之外，而 readExternalFile
    // 正是文档给这一场景指定的「OS 直通读外部路径」通道——本插件也不在 biome 的 node:* 例外清单里。
    readText: async absPath => {
      try {
        return new TextDecoder().decode(await proc.readExternalFile(absPath));
      } catch {
        return undefined;
      }
    },
    // 宿主不提供插件来源（打包宿主）时视同本次没有新插件
    rescanPlugins: async () => (await (caps.source.present ? caps.source.use.rescan() : undefined)) ?? [],
    // 宿主不提供插件来源时没有经它登记的插件：已登记的同名插件一律不是这次装的包
    loaded: name => caps.source.present && caps.source.use.loaded(name),
    // 与发现驱动跳过声明了已登记插件名的包同一判据：看主实例
    isPluginRegistered: name => caps.plugins.use.getPlugin(name) !== undefined,
    pluginStatus: () => caps.plugins.use.getStatus(),
    availableServices: () => caps.services.use.names(),
    idle: () => caps.plugins.use.idle(),
    // 重启并交付回滚凭据。core 只透传 rollback（不解释形状），由 runtime 的重启策略
    // 在「新实例 ready 前夭折」时消费——触发者与执行者同为父进程，全程内存不落盘。
    restartApp: rollback => caps.app.use.restart({ rollback }),
    // 彻底卸载：dispose 上下文并从注册表移除。
    // 区别于 disable（仅置禁用态，仍滞留在插件列表里）。
    // 撤销通道 = 市场页能用所依赖的三样：页面本身 / 托管它的服务端 / 装卸能力本身。
    // 取每个服务当前生效的 provider（`services.all` 的首个即是），contextId 就是包名
    // （插件以包名做实例 id，webui-server 也用包名做前端候选的实例 id）。
    // 服务缺席时该项自然不在列表里——不启用 WebUI 的部署不受影响。
    // contextId 直接就是包名，**不要**再切分：包名带 scope（`@aalis/plugin-webui-client`）时
    // `split('/')[0]` 会把它截成 `@aalis`，与下游 `lifeline.includes(pluginName)` 永不相等，
    // 整道闸对全部 scoped 包恒不触发（实测三个目标全放行）。这三个服务都由以包名为实例 id 的
    // 激活注册，contextId 不含 entryId 后缀；真出现多实例后缀要靠模块声明 `reusable`，
    // 而这三个都没有，故也不需要为此加解析。
    recoveryChannelProviders: () => [
      ...new Set(
        ['webui-client', 'webui-server', packageManager.name].flatMap(service => {
          const id = caps.services.use.inspect(service)[0]?.contextId;
          return id ? [id] : [];
        }),
      ),
    ],

    unloadPlugin: async name => {
      await caps.plugins.use.unload(name);
    },
    // 文档没有改动时不保存：没东西要写，也就不该因配置文件的状况报失败
    cleanupConfig: async (instanceIds, removeConfig) => {
      if (!caps.hostConfig.present) return;
      const doc = caps.hostConfig.use;
      const plugins = doc.getAll().plugins;
      const touched = instanceIds.filter(
        id => doc.isPluginDisabled(id) || (removeConfig && Object.hasOwn(plugins, id)),
      );
      if (touched.length === 0) return;
      for (const id of touched) {
        doc.setPluginEnabled(id, true);
        if (removeConfig) doc.removePluginConfig(id);
      }
      await doc.save();
    },
  });
  // 停用、重启与停机时中止信号已打断在途的 npm：等它退出、被打断的把 package.json 与锁文件还原之后才算收尾完。超过清理宽限
  // 还没落定时 core 把本实例记为未停下，落定之前不启动新实例，新实例的 npm 不会与旧实例的 npm 或还原同时改这两份文件
  caps.lifecycle.use.onDrain(settled, '等在途的 npm 退出，被打断的还原 package.json 与锁文件');
  return service;
}

/** install/uninstall 的显式依赖（从服务选择解耦，便于集成测试） */
export interface PackageManagerDeps {
  proc: ProcessService;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /**
   * 本插件这次激活的中止信号：停用、重启与停机时断开，交给 npm，打断在途的操作。断开之后不再受理新操作
   */
  signal: AbortSignal;
  /** 安装集目录的绝对路径（宿主 host-paths 的 `app`）：根 package.json 读取、npm 的 cwd。 */
  projectRoot(): string;
  /** 读文本文件；不存在或读失败返回 undefined。注入以便单测。 */
  readText(absPath: string): Promise<string | undefined>;
  rescanPlugins(): Promise<string[]>;
  /**
   * 以这个插件名登记的主实例是不是经插件来源加载的（插件来源的 `loaded`）；没有登记或不是经插件来源登记的为 false。
   *
   * 这是判定「本次安装是否就位」的**唯一正确判据**：此刻注册表里的这个插件是从目标包加载的。不能用 `rescanPlugins()` 的返回值：
   * 它是全局副作用的产物——宿主的 rescan 对已注册插件直接跳过，返回的是「本次扫描新
   * 加载的**全部**插件」，与本次目标无对应关系。用它会在两个场景下给出错误结论：
   * 重装已注册插件时恒返回空（误报失败）；两个安装并发时先跑完的那个会把对方的战果
   * 一并算作自己的（谎报），后跑的则拿到空数组（误报失败）。也不能只看插件名已登记：名字被宿主直接登记的插件占着时，
   * 发现驱动跳过目标包，注册表里那个插件不是它。
   *
   * 插件名即包名，传入的就是 npm 包名。
   */
  loaded(name: string): boolean;
  /** 以这个插件名登记的主实例此刻是否在注册表里：不是从目标包加载的，就是插件名被占着、目标包被跳过 */
  isPluginRegistered(name: string): boolean;
  /** 运行时插件状态，供服务依赖者判定（{@link findServiceDependents}）、装后回执（按主实例状态说明）与卸载时按定义 name 找全部实例。 */
  pluginStatus(): ReadonlyArray<ServiceStatus>;
  /** 当前有提供者的服务名（`services.names()`，含宿主在根上提供的），服务依赖者判定用 */
  availableServices(): Iterable<string>;
  /**
   * 等插件状态机静置（plugins 服务的 `idle()`），装后回执读状态之前调用：rescan 登记新插件时若已有重算在飞，
   * 登记只排队、立即返回，主实例还是 pending。不等转入后台的慢激活。
   */
  idle(): Promise<void>;
  /** 彻底卸载插件（dispose + 从注册表移除）。 */
  unloadPlugin(name: string): Promise<void>;
  /**
   * 当前**承载撤销通道**的服务提供者包名列表（去重）。卸掉其中任何一个，用户就只能开
   * shell 恢复——与内核/宿主同一条判据。见 uninstallOne 的闸一之二。
   */
  recoveryChannelProviders(): string[];
  /**
   * 卸载后整理配置文档并落盘：清掉这些实例的停用标记（否则重装时带着上次的停用态登记）；removeConfig 时再删它们的配置段，
   * 落盘后只有这些段引用的密钥由宿主一并删掉。落盘失败以拒绝传出。宿主不提供配置文档时什么都不做
   */
  cleanupConfig(instanceIds: string[], removeConfig: boolean): Promise<void>;
  /**
   * 重启进程并交付回滚凭据（新实例启动失败时由重启策略消费）。宿主没有重启策略或应用已开始停机时同步抛错
   * （core 的 `app.restart()`）。
   */
  restartApp(rollback: RestartRollback): void;
}

/** `@scope/foo@1.2.3` → `@scope/foo`（剥掉版本后缀，保留 scope）。 */
export function stripVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

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
 * `@aalis/api-session-manager@0.9.1` 38 字节），拿个数近似字节等于用一个与约束无关的
 * 量设闸——如「最多 50 个包」比真实约束低约 600 倍，会把本仓 99 个包的协调发版
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
export function buildUpdateSpecs(
  targets: readonly UpdateTarget[],
): { specs: string[]; error?: undefined } | { specs?: undefined; error: TextRef } {
  if (!Array.isArray(targets) || targets.length === 0) return { error: t('noTargets') };
  const specs: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const target of targets) {
    const name = typeof target?.name === 'string' ? target.name : '';
    const version = typeof target?.version === 'string' ? target.version : '';
    if (!PKG_NAME_RE.test(name)) return { error: t('badName', { name: JSON.stringify(name) }) };
    if (!VERSION_RE.test(version)) return { error: t('badVersion', { name, version: JSON.stringify(version) }) };
    // 同名多版本会让 npm 取最后一个，静默丢弃前面的选择——宁可让用户重选。
    if (seen.has(name)) return { error: t('duplicateTarget', { name }) };
    seen.add(name);
    const spec = `${name}@${version}`;
    // 按**字节**计而非按个数：这些 spec 逐条成为 argv，而 execve 的约束是参数块的总字节数，
    // 与包数无关（`ms@2.0.0` 8 字节，`@aalis/api-session-manager@0.9.1` 38 字节）。
    // 超限即整批停下，与本函数其余校验同一策略：不猜、不截断。
    bytes += Buffer.byteLength(spec) + 1; // +1 = argv 之间的 NUL 分隔
    if (bytes > SPEC_ARGV_BUDGET) {
      return { error: t('tooManyTargets', { budget: SPEC_ARGV_BUDGET }) };
    }
    specs.push(spec);
  }
  return { specs };
}

/**
 * 从 npm 的失败输出里摘出冲突要点，供前端直接展示。保留根项目的声明行（`… from the root project`），看得出冲突由
 * 哪条根依赖引起；完整报告的路径行（`…-eresolve-report.txt`）随不分大小写的 ERESOLVE 一并保留。纯函数，便于单测。
 */
export function extractPeerConflicts(output: string): string[] {
  const lines = output.split('\n');
  const picked = lines.filter(l =>
    /ERESOLVE|peer |Conflicting peer|Found:|Could not resolve|from the root project/i.test(l),
  );
  return picked.map(l => l.replace(/^npm (ERR!|error|warn)\s*/i, '').trim()).filter(l => l.length > 0);
}

/** npm 失败的几类：与 create-aalis 装依赖失败认的同一套，核对用例钉住 */
type NpmFailureKind = 'disk' | 'permission' | 'platform' | 'peer' | 'browser' | 'native' | 'missing' | 'network';

/**
 * npm 失败的几类与给用户看的一句（原因与修法）。浏览器下载与原生编译先于网络认：它们的输出里也可能带网络错误码，但修法
 * 不同
 */
const NPM_FAILURES: Array<{
  kind: NpmFailureKind;
  match: RegExp;
  describe(output: string, found: RegExpExecArray): TextRef;
}> = [
  { kind: 'disk', match: /\bENOSPC\b/, describe: () => t('npmDisk') },
  { kind: 'permission', match: /\bEACCES\b/, describe: () => t('npmPermission') },
  {
    kind: 'platform',
    match: /\bEBADPLATFORM\b/,
    describe: output => {
      const pkg = /Unsupported platform for (\S+?)@\d/.exec(output)?.[1];
      return pkg === undefined ? t('npmPlatformUnknown') : t('npmPlatform', { pkg });
    },
  },
  {
    kind: 'peer',
    match: /\bERESOLVE\b/,
    describe: output => t('npmPeer', { conflicts: textClauses(extractPeerConflicts(output)) }),
  },
  {
    kind: 'browser',
    match: /Failed to set up (?:chrome|chrome-headless-shell|firefox)\b|node_modules[\\/]puppeteer\s*$/m,
    describe: () => t('npmBrowser'),
  },
  {
    kind: 'native',
    match: /gyp ERR!|node-gyp|prebuild-install/,
    describe: output => {
      const pkg = /^npm (?:error|ERR!) path \S*node_modules[\\/]((?:@[^\\/\s]+[\\/])?[^\\/\s]+)\s*$/m.exec(output)?.[1];
      return pkg === undefined ? t('npmNativeUnknown') : t('npmNative', { pkg });
    },
  },
  {
    kind: 'missing',
    match: /\b(E404|ETARGET)\b/,
    // 镜像源同步有延迟，刚发布的版本可能还没有
    describe: (_output, [, code]) => t('npmMissing', { code }),
  },
  {
    kind: 'network',
    match: /\b(ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/,
    describe: (_output, [, code]) => t('npmNetwork', { code }),
  },
];

/** 按先后认 npm 的失败输出：第一个对上的类别与匹配结果 */
function recognizeNpmFailure(output: string) {
  for (const failure of NPM_FAILURES) {
    const found = failure.match.exec(output);
    if (found) return { failure, found };
  }
  return undefined;
}

/** npm 的失败输出认出是哪一类，认不出时为 undefined。纯函数，便于单测 */
export function npmFailureKind(output: string): NpmFailureKind | undefined {
  return recognizeNpmFailure(output)?.failure.kind;
}

/**
 * 把 npm 的失败输出归成一句给用户看的话：认得出的写原因与修法，认不出的写 npm 的最后一条报错，并指向日志与排障页。
 * 整段输出由调用方记进日志，回执与提示里只放这一句。纯函数，便于单测。
 */
export function describeNpmFailure(output: string): TextRef {
  const known = recognizeNpmFailure(output);
  if (known) return known.failure.describe(output, known.found);
  const errors = output
    .split('\n')
    .map(line => /^npm (?:error|ERR!)\s*(.*)$/.exec(line.trim())?.[1]?.trim())
    .filter((line): line is string => !!line && !line.startsWith('A complete log of this run'));
  const last = errors.at(-1) ?? output.trim().split('\n').at(-1)?.trim();
  return t('npmOther', { error: String(last) });
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
export function findUnmetPeers(output: string, targetNames: readonly string[]): TextRef[] {
  const names = new Set(targetNames);
  // npm 会把同一条 peer 冲突在不同上下文里重复打印，去重后再给用户。
  const out = new Map<string, TextRef>();
  for (const raw of output.split('\n')) {
    const line = raw.replace(/^npm (ERR!|error|warn)\s*/i, '').trim();
    const m = /^peer\s+(\S+?)@"([^"]+)"\s+from\s+(.+)$/.exec(line);
    if (!m) continue;
    if (!names.has(m[1])) continue;
    out.set(`${m[3]}\0${m[1]}@${m[2]}`, t('needsPeer', { dependent: m[3], peer: `${m[1]}@${m[2]}` }));
  }
  return [...out.values()];
}

/**
 * 包管理核心：install/uninstall 的纯依赖实现（不碰服务选择，可单测）。
 * 所有文件操作走 process 服务（子进程：npm/cp/test），目标是项目根 package.json 与
 * node_modules——不经 storage 沙盒。
 * 能力组装层见 createService。
 */
export function createPackageManager(deps: PackageManagerDeps): PackageManagerService & { settled(): Promise<void> } {
  const { proc, log, signal } = deps;

  /**
   * 当前占用的操作描述；`null` = 空闲。
   *
   * install / uninstall / update 三者都会改**同一个**根 `package.json`，而 npm 的写法是
   * 「读整份 → 改内存 → 整份写回」。并行时是经典的丢失更新：A 与 B 各自读到同一份旧内容，
   * 后写者整份覆盖，先写者新增的那条依赖消失——包的文件却已经落进 node_modules。而
   * `createNodeModulesPluginLoader` **只遍历根依赖的键、从不扫 node_modules 目录**，
   * 于是那个包永远不会被加载：装成功了，重启后插件不见了，用户无从判断。
   *
   * 锁必须在**服务层**：本服务对外公开，任何插件都能绕过 HTTP 路由直接调，
   * 加在路由或前端都不算数。
   */
  let inflight: TextRef | null = null;
  /**
   * 进程即将重启（update 装完、重启已受理后置位），此后**永不释放**锁。
   *
   * 重启不是立刻发生的（延迟 500ms + stop + spawn），这段窗口里若放新操作进来，
   * 它会被 `process.exit` 腰斩在半路，留下半装状态。
   */
  let terminal = false;
  /** 在途操作落定（npm 退出，被打断的已还原两份文件）；本激活收尾时等它，见 settled */
  let current: Promise<void> = Promise.resolve();

  /**
   * 串行闸：占用中直接**拒绝**而非排队。
   *
   * 拒绝而非排队的决定性理由：update 成功后进程立即重启，排在它后面的操作必然被腰斩。
   * 排队在这里是错的语义——「一次一个」才是这三个操作的真实约束。
   * 本激活已开始关闭时同样拒绝：收尾段里服务还登记着，这时进来的请求不再启动 npm。
   */
  async function exclusive<T extends Pick<InstallResult, 'ok' | 'message'>>(
    what: TextRef,
    run: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) return { ok: false, message: t('closing') } as T;
    if (inflight) {
      return { ok: false, message: t('busy', { operation: inflight }) } as T;
    }
    inflight = what;
    const running = run();
    current = running.then(
      () => {},
      () => {},
    );
    try {
      return await running;
    } finally {
      if (!terminal) inflight = null;
    }
  }

  /**
   * 等 work 落定，本激活一开始关闭就不再等（work 照常往下走）。收尾在等本操作落定（onDrain），而 idle、卸载本插件选中的
   * 提供者都要等这次收尾所在的计划走完：不这样两边互等到清理宽限。等完摘掉监听，不挂在长寿的信号上
   */
  async function untilClosing(work: Promise<unknown>): Promise<void> {
    if (signal.aborted) return;
    let stopWaiting!: () => void;
    const aborted = new Promise<void>(resolve => {
      stopWaiting = resolve;
    });
    signal.addEventListener('abort', stopWaiting, { once: true });
    try {
      await Promise.race([work, aborted]);
    } finally {
      signal.removeEventListener('abort', stopWaiting);
    }
  }

  /** 跑一条 npm 命令：失败时整段输出记进日志，抛出的错误只带 {@link describeNpmFailure} 认出的原因与修法 */
  async function npm(
    args: string[],
    cwd: string,
    timeout?: number,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    try {
      return (await execProcBoth(proc, 'npm', args, cwd, timeout, extraEnv, signal)).stdout;
    } catch (err) {
      // 随本激活关闭被中止的不算失败：调用方按中止回执
      if (signal.aborted) throw err;
      const output = err instanceof Error ? err.message : String(err);
      log.error(`npm ${args.join(' ')} 失败: ${output}`);
      throw new TextError(describeNpmFailure(output));
    }
  }

  /** 安装源查询的缓存：只留成功的结果，失败时清掉，下次调用重查 */
  let registryUrl: Promise<string> | undefined;
  function registry(): Promise<string> {
    if (!registryUrl) {
      // 与 install / update 同一 cwd：项目根的 .npmrc 一并生效
      registryUrl = execProc(proc, 'npm', ['config', 'get', 'registry'], deps.projectRoot(), signal).then(out => {
        const url = out.trim().replace(/\/+$/, '');
        if (!/^https?:\/\/\S+$/i.test(url)) {
          throw new Error(`npm config get registry 的输出不是 http(s) 地址: ${JSON.stringify(out.trim())}`);
        }
        return url;
      });
      registryUrl.catch(() => {
        registryUrl = undefined;
      });
    }
    return registryUrl;
  }

  /**
   * 路径存在性：`test -d|-f <abs>`（不存在 → exit 1 → 抛 → false）。绝对路径，cwd 无关。被本激活中止时照抛，不读成「没有」
   */
  async function pathExists(absPath: string, kind: 'd' | 'f'): Promise<boolean> {
    try {
      await proc.execFile('test', [`-${kind}`, absPath], { cwd: deps.projectRoot(), timeout: 10_000, signal });
      return true;
    } catch (err) {
      if (signal.aborted) throw err;
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

  /**
   * 操作前的 package.json 与锁文件（RestartRollback 的 restore 形状）：被打断时由本插件写回，更新成功时原样交给重启策略作回滚。
   * 原本没有的记为「写回时删掉」：npm install 会新建锁文件，回滚只写回不删的话，留着它会让 postRestore 判定新版仍满足
   * 还原后的范围、`up to date` 什么都不做；用空内容占位也不行（会得到坏 JSON）。readText 不分不存在与读失败：读不到的再看
   * 在不在，在而读不出的不启动 npm，免得记成「原本没有」、还原时把它删掉。取不到快照（在而读不出，或查在不在时被中止）时交回
   * 回执，与 npmOnTree 同一口径：都还没动文件
   */
  async function snapshotProject(root: string): Promise<RestartRollback['restore'] | TextRef> {
    const files: RestartRollback['restore'] = [];
    for (const path of [`${root}/package.json`, `${root}/package-lock.json`]) {
      const content = await deps.readText(path);
      if (content !== undefined) {
        files.push({ path, content });
        continue;
      }
      // pathExists 只在被中止时抛
      const exists = await pathExists(path, 'f').catch(() => null);
      if (exists === null) return t('abortedNoChange');
      if (exists) return t('snapshotUnreadable', { path });
      files.push({ path, content: '', deleteIfEmpty: true });
    }
    return files;
  }

  /**
   * 把 snapshot 写回（npm 已退出，不会在写回之后再写一遍）。经 process 服务：先 tee 到临时文件再 mv 换上，写到一半出错时
   * 目标仍是 npm 留下的那份、不是半截。这几条命令不接中止信号：写回本身就是中止之后的收尾。返回没还原成的那几份与原因
   */
  async function restoreProject(
    snapshot: RestartRollback['restore'],
    root: string,
  ): Promise<Array<{ path: string; error: string }>> {
    const run = (cmd: string, args: string[], input?: string) =>
      proc.execFile(cmd, args, { cwd: root, timeout: 10_000, ...(input === undefined ? {} : { input }) });
    const failed: Array<{ path: string; error: string }> = [];
    for (const file of snapshot) {
      const tmp = `${file.path}.aalis-restore`;
      try {
        if (file.deleteIfEmpty && file.content === '') await run('rm', ['-f', file.path]);
        else {
          await run('tee', [tmp], file.content);
          await run('mv', ['-f', tmp, file.path]);
        }
      } catch (err) {
        failed.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
        await run('rm', ['-f', tmp]).catch(() => {});
      }
    }
    return failed;
  }

  /**
   * 跑一条会改安装树的 npm（install、uninstall）。本激活关闭时随中止信号打断：等它退出后把 package.json 与锁文件写回
   * snapshot，返回中止的回执（warn 日志同样写明）；执行完毕返回 undefined，npm 自己失败照常抛出。开始执行之前已中止的不跑
   */
  async function npmOnTree(
    args: string[],
    root: string,
    snapshot: RestartRollback['restore'],
    extraEnv?: Record<string, string>,
  ): Promise<TextRef | undefined> {
    if (signal.aborted) return t('abortedNoChange');
    try {
      await npm(args, root, INSTALL_TIMEOUT_MS, extraEnv);
      return undefined;
    } catch (err) {
      if (!signal.aborted) throw err;
    }
    const failed = await restoreProject(snapshot, root);
    const message =
      failed.length === 0
        ? t('interrupted')
        : t('interruptedRestoreFailed', { items: failed.map(f => t('restoreFailedItem', f)) });
    log.warn(`npm ${args.join(' ')} 随本插件停用被中止：${toSource(message)}（安装目录 ${root}）`);
    return message;
  }

  /**
   * 插件名即包名。这个名字被不是从这个包加载的插件占着（宿主直接登记的）时，那些实例、配置与它提供的服务都不是这个包的：
   * 卸这个包只卸包
   */
  function heldByHost(name: string): boolean {
    return deps.isPluginRegistered(name) && !deps.loaded(name);
  }

  /**
   * 卸载 name 会打断的插件（{@link findServiceDependents}）；名字被宿主直接登记的插件占着时卸的只是包，断不了谁。
   * 卸载闸与市场的卸载前预警共用这一份
   */
  function dependentsOf(name: string): string[] {
    if (heldByHost(name)) return [];
    return findServiceDependents(name, deps.pluginStatus(), deps.availableServices());
  }

  /** 注册表里该定义的全部 instanceId；一个都没登记（包没加载上）时只整理定义 name 本身。 */
  function instanceIdsFor(defName: string): string[] {
    const ids = deps
      .pluginStatus()
      .filter(p => p.name === defName)
      .map(p => p.instanceId);
    return ids.length > 0 ? ids : [defName];
  }

  /**
   * 装前类型闸：经 `npm view <spec> keywords --json` 读 registry 上的类型关键词（在项目根跑，
   * 沿用项目与本机的 npm 源配置），判据与卸载同一份（{@link nonMarketKind}）。闸放服务层而非
   * HTTP 路由——本服务对外公开，任何插件都能绕过路由直接调。返回拒绝理由，`undefined` = 放行。
   */
  async function installKindRefusal(npmPkg: string, root: string): Promise<TextRef | undefined> {
    const out = (await npm(['view', npmPkg, 'keywords', '--json'], root)).trim();
    // 包没有 keywords 字段时 npm 什么都不输出；spec 是版本范围时按版本逐个给出、返回二维数组
    const parsed: unknown = out ? JSON.parse(out) : [];
    const perVersion = Array.isArray(parsed) && parsed.length > 0 && parsed.every(Array.isArray) ? parsed : [parsed];
    const kind = perVersion.map(kw => nonMarketKind(kw)).find(k => k !== undefined);
    if (!kind) return undefined;
    return t(kind === 'other' ? 'installUnmarked' : 'installBundled', { name: npmPkg, kind: KIND_NAMES[kind] });
  }

  /**
   * 装完的统一判定：rescan 出新插件即成功；没出新插件时按目标是否**声明自己是插件**分流。
   * 「声明了插件却没被发现」正是那条静默假成功——必须报失败，否则用户看到 ok 却什么也没装上。
   * 插件名即包名。就位查的是以包名登记的主实例是不是从目标包加载的，不只看名字已登记：名字被宿主直接登记的插件占着时
   * 发现驱动跳过目标包，同样报失败并写明。就位但主实例没有激活时仍回 ok：包确实装上、已进插件列表；
   * message 按重算落定后的状态说明——激活失败（如缺配置，改好配置即可重试）、慢激活转入后台仍在进行、等待 required 依赖。
   */
  async function settleInstall(npmPkg: string, installedPkgJsonPath: string, where: string): Promise<InstallResult> {
    const target = stripVersion(npmPkg);
    // rescan 只当副作用用（让加载器发现新包），**不看返回值**——判据是目标自身是否就位。
    await deps.rescanPlugins();
    if (deps.loaded(target)) {
      // 回执按等完（或不再等）时读到的状态写
      await untilClosing(deps.idle());
      const main = deps.pluginStatus().find(p => p.instanceId === target);
      const settled = (message: TextRef): InstallResult => ({ ok: true, message, plugin: target });
      switch (main?.state) {
        case 'error':
          return settled(t('installedErrored', { target, error: failureText(main) ?? t('seeLogs') }));
        case 'activating':
          return settled(t('installedActivating', { target }));
        case 'pending':
          return settled(t('installedPending', { target }));
      }
      return settled(t('installedLoaded', { target }));
    }
    const meta = await readJson(installedPkgJsonPath);
    if (!declaresPlugin(meta)) return { ok: true, message: t('installedNonPlugin', { target }) };
    if (!deps.isPluginRegistered(target)) return { ok: false, message: t('installedNotLoaded', { where }) };
    return { ok: false, message: t('installedNameTakenByHost', { target }) };
  }

  /**
   * 安装：写根 `dependencies` —— 加载器**唯一**的发现来源。
   *
   * 不按「项目形态」分叉：检测到 `pnpm-workspace.yaml` 就把 npm 包解包成
   * `packages/<dir>` 源码是错的——那个文件与真正生效的加载器**没有因果关系**，加载器是入口
   * 文件传给 `startAalis` 的（默认读根依赖，本仓显式传 fs 加载器扫 packages/）。于是一个
   * 用 pnpm 工作区、却不给 `startAalis` 传插件加载器（走默认的 node_modules 加载器）的用户，包会被装进加载器永远不看的地方，静默失败。
   *
   * 只有一条路径。真正的 monorepo 由下面的 `hasWorkspaceProtocol` 守卫拦住并说清
   * 该用什么工具——那才是开发者场景，不该用市场往自己仓里塞源码。
   */
  async function installTo(npmPkg: string): Promise<InstallResult> {
    const root = deps.projectRoot();
    const rootPkg = await readJson(`${root}/package.json`);
    if (hasWorkspaceProtocol(rootPkg)) {
      return { ok: false, message: t('workspaceInstall') };
    }
    let refused: TextRef | undefined;
    try {
      refused = await installKindRefusal(npmPkg, root);
    } catch (err) {
      // 查类型的 npm view 被中止：还没动文件
      if (signal.aborted) return { ok: false, message: t('abortedNoChange') };
      throw err;
    }
    if (refused) return { ok: false, message: refused };
    log.info(`正在安装: ${npmPkg} → 根依赖 + node_modules`);
    // **刻意不加 `--ignore-scripts`**：依赖树的 preinstall/install/postinstall 会照常执行。
    // 三条理由：脚手架自身就是裸 `npm install`（其生成的 README 也教用户裸装），加了会让
    // 「同一个包、同一个用户、两条途径」行为分叉；会打穿 plugin-tool-browser（puppeteer）；而真正的增量
    // 风险只有传递依赖的 install 脚本这一片——入口是 owner 级、包名由用户自己点选、包本体
    // 反正会被动态 import 执行（插件与内核同进程同权限，见 docs/concepts/security-model.md §1）。
    //
    // peer 护栏与更新预检相同（STRICT_PEERS_ENV）。代价：本就靠 legacy-peer-deps 容忍既有
    // peer 冲突的项目，市场安装会整体失败，故失败文案要点明原因（见 describeNpmFailure）。
    const snapshot = await snapshotProject(root);
    if (!Array.isArray(snapshot)) return { ok: false, message: snapshot };
    const stopped = await npmOnTree(['install', npmPkg, '--no-audit', '--no-fund'], root, snapshot, STRICT_PEERS_ENV);
    if (stopped) return { ok: false, message: stopped };
    const bare = stripVersion(npmPkg);
    return settleInstall(npmPkg, `${root}/node_modules/${bare}/package.json`, 'node_modules');
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
   * 项目 `.npmrc` 目前不拷进副本。代价：私有源用户的预检会跑去公共源解析（包只在私有源上
   * 就 404/401 → 更新被挡住且报错文不对题）。早先 `test/integration/install-chain.test.ts` 的
   * 真实 npm 用例显示「带上 `.npmrc` 后第 2 条护栏失效」，成因是当时测试夹具的进程桩没有转发
   * `opts.env`，并非环境变量压不过项目级 `.npmrc`（见 STRICT_PEERS_ENV）。是否拷入另议。
   *
   * 判据只能是解析告警文本：`--dry-run --json` 实测只给 `{added, removed, changed,
   * audited, funding}`，无任何冲突信息；退出码在本场景恒为 0（npm 把命令行显式 spec
   * 视为用户意图，只 warn 就放行），`--strict-peer-deps` 在副本里同样不改变这一点，
   * 故不再传它——留着只会让人误以为有额外保障。
   */
  async function preflightInSandbox(specs: string[], root: string): Promise<Array<string | TextRef> | undefined> {
    const tmp = await proc.makeTempDir('preflight');
    try {
      // 直接 cp 现有文件，不重新写内容——与本插件其余文件操作同一路子（走 process 服务的
      // POSIX 命令），也省掉一个只为此处存在的写原语。
      await execProc(proc, 'cp', [`${root}/package.json`, `${tmp.path}/package.json`], tmp.path, signal);
      const lock = `${root}/package-lock.json`;
      if (await pathExists(lock, 'f')) {
        await execProc(proc, 'cp', [lock, `${tmp.path}/package-lock.json`], tmp.path, signal);
      }
      let output: { stdout: string; stderr: string };
      try {
        output = await execProcBoth(
          proc,
          'npm',
          ['install', ...specs, '--dry-run', '--no-audit', '--no-fund'],
          tmp.path,
          INSTALL_TIMEOUT_MS,
          STRICT_PEERS_ENV,
          signal,
        );
      } catch (err) {
        if (signal.aborted) throw err;
        // 非零退出：npm 判定 peer 无解（ERESOLVE 等）时报冲突要点；别的失败（连不上源等）不是冲突，抛出原因与修法
        const raw = err instanceof Error ? err.message : String(err);
        const conflicts = extractPeerConflicts(raw);
        if (conflicts.length > 0) return conflicts;
        log.error(`更新预检失败: ${raw}`);
        throw new TextError(describeNpmFailure(raw));
      }
      const unmet = findUnmetPeers(`${output.stderr}\n${output.stdout}`, specs.map(stripVersion));
      return unmet.length > 0 ? unmet : undefined;
    } finally {
      await tmp.cleanup().catch(() => {});
    }
  }

  /**
   * 批量更新。形状是「一次算全量 → 整组预检 → 一次 install → 一次重启」，
   * 重启次数恒为 1，与改了多少个包无关（语义见 {@link PackageManagerService.update}）。
   */
  async function updateAll(targets: UpdateTarget[]): Promise<UpdateResult> {
    const built = buildUpdateSpecs(targets);
    if (built.error) return { ok: false, message: built.error };
    const { specs } = built;

    const root = deps.projectRoot();
    // 能不能更新是**每个包自己的来源**说了算（下面的 isRegistryDep 闸），不是整个项目的属性。
    const rootPkgPath = `${root}/package.json`;
    const rootPkgText = await deps.readText(rootPkgPath);
    if (rootPkgText === undefined) return { ok: false, message: t('noRootPackage', { path: rootPkgPath }) };
    const rootPkg = await readJson(rootPkgPath);
    if (hasWorkspaceProtocol(rootPkg)) return { ok: false, message: t('workspaceUpdate') };
    // 只允许更新「根依赖里以 semver 范围声明」的包。闸放在服务层而非 HTTP 路由——
    // 本服务对外公开，任何插件都能绕过路由直接调用（理由见 isRegistryDep）。
    const rootDependencies = (rootPkg?.dependencies ?? {}) as Record<string, string>;
    const notUpdatable = targets.filter(target => !isRegistryDep(rootDependencies[target.name]));
    if (notUpdatable.length > 0) {
      return { ok: false, message: t('notUpdatable', { names: notUpdatable.map(target => target.name) }) };
    }

    // ── 读取每个目标的当前实装版本 ──
    // 两处都要用：(a) 降级守卫；(b) 回滚凭据钉精确旧版。两者都不能靠根 package.json 的
    // 声明——那是**范围**，回滚时按范围重解析只会又解到刚崩掉的新版。
    const installedVersions = new Map<string, string>();
    for (const target of targets) {
      const text = await deps.readText(`${root}/node_modules/${target.name}/package.json`);
      if (text === undefined) continue;
      try {
        const v = (JSON.parse(text) as { version?: unknown }).version;
        if (typeof v === 'string') installedVersions.set(target.name, v);
      } catch {
        /* 坏 JSON：当作读不到，由下面的守卫拒掉 */
      }
    }

    // ── 降级守卫 ──
    // 闸放在服务层而非 HTTP 路由：本服务对外公开，任何插件都能绕过路由直接调用。
    // 拒绝而非放行的理由：registry 的 dist-tags.latest 可以**低于**本地已装版本（发布事故后
    // `npm dist-tag add pkg@旧版 latest` 回滚，或用户曾装过预发布版），此时「更新」会静默降级；
    // 读不到已装版本同样拒——无从判断方向就不动，用户可显式卸载重装。
    const notUpgrade = targets.filter(target => !isUpgrade(installedVersions.get(target.name), target.version));
    if (notUpgrade.length > 0) {
      const items = notUpgrade.map(({ name, version }) =>
        t('downgradeItem', { name, installed: installedVersions.get(name) ?? t('unknown'), version }),
      );
      return { ok: false, message: t('notUpgrade', { items }) };
    }

    // ── 预检：整组一次，不逐个 ──
    // 逐个预检发现不了「A@new 要 core>=0.10、B@new 要 core<0.10」这类只在合并时冲突的组合。
    log.info(`更新预检: ${specs.join(' ')}`);
    const reject = (conflicts: Array<string | TextRef>): UpdateResult => ({
      ok: false,
      message: t('preflightRejected'),
      conflicts,
    });
    let verdict: Array<string | TextRef> | undefined;
    try {
      verdict = await preflightInSandbox(specs, root);
    } catch (err) {
      if (signal.aborted) return { ok: false, message: t('abortedNoChange') };
      return { ok: false, message: t('preflightFailed', { error: textOf(err) }) };
    }
    if (verdict) return reject(verdict);

    // ── 快照：预检过了才有必要 ──
    // lockfile 与 package.json 必须一起回退，否则还原后的树是「声明旧版、锁定新版」。被打断时本插件按它写回，装完交给重启策略
    const restore = await snapshotProject(root);
    if (!Array.isArray(restore)) return { ok: false, message: restore };

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
      const stopped = await npmOnTree(['install', ...specs, '--no-audit', '--no-fund'], root, restore);
      if (stopped) return { ok: false, message: stopped };
    } catch (err) {
      return { ok: false, message: t('installFailedRetry', { error: textOf(err) }) };
    }

    // ── 重启接管 ──
    // 回滚凭据交给重启策略：只有它能观察到「新实例 ready 前夭折」。插件级失败不在此列
    // ——插件起不来会停在 error 态且 WebUI 可见，自动回滚反而会掩盖问题。
    // postRestore 钉**精确旧版**，不用裸 `npm install`。
    // 裸 install 只能按还原后的 package.json 重解析，而声明通常是 caret 范围（`^1.0.0`），
    // 刚崩掉的新版（1.1.0）本身就满足它——于是 npm 又把它装回来，node_modules 分毫未变，
    // 而重启策略照样报告已回滚并拉起旧版本。实测：有锁时正常，无锁时静默失效。
    // `--no-save` 保证 package.json 维持 restore 写回的原样，不被 npm 改写成 `^旧版`。
    // 降级守卫已保证每个 target 都有已装版本（读不到的在那里就被拒了），此处的 undefined
    // 过滤只是让类型收窄，不承担逻辑。
    const pinned = targets
      .map(target => {
        const v = installedVersions.get(target.name);
        return v === undefined ? undefined : `${target.name}@${v}`;
      })
      .filter((s): s is string => s !== undefined);
    // 再把「被这次安装顺带改了版本」的包一并钉回旧版（理由见上面 treeBefore 处的注释）。
    // 只回退**本来就在**的包：新增的包钉不回去（它更新前不存在），留给 npm 的 extraneous。
    const named = new Set(targets.map(target => target.name));
    const treeAfter = await readInstalledTree(deps, root);
    for (const [name, before] of treeBefore) {
      if (named.has(name)) continue;
      const after = treeAfter.get(name);
      if (after !== undefined && after !== before) pinned.push(`${name}@${before}`);
    }
    try {
      deps.restartApp({
        reason: `marketplace-update:${specs.join(',')}`,
        restore,
        postRestore: { cmd: 'npm', args: ['install', ...pinned, '--no-save', '--no-audit', '--no-fund'], cwd: root },
      });
    } catch (err) {
      // 宿主没有重启策略（嵌入宿主）或应用已开始停机时 core 同步抛错：包已装好、不会重启，锁照常放开，回执照实说
      return { ok: true, restarting: false, message: t('updatedRestartUnavailable', { specs, error: textOf(err) }) };
    }
    log.info(`更新完成，正在重启接管: ${specs.join(' ')}`);
    // 重启受理之后锁不再释放：重启是延迟发生的，这段窗口放新操作进来会被 process.exit 腰斩。
    terminal = true;
    return { ok: true, restarting: true, message: t('updated', { specs }) };
  }

  return {
    update: targets => exclusive(t('opUpdate', { names: targets.map(x => x.name) }), () => updateAll(targets)),

    install: npmPkg =>
      exclusive(t('opInstall', { name: npmPkg }), async () => {
        const bad = validatePackageSpec(npmPkg);
        if (bad) return { ok: false, message: bad };
        try {
          return await installTo(npmPkg);
        } catch (err) {
          const message = textOf(err);
          log.error(`安装 "${npmPkg}" 失败: ${toSource(message)}`);
          return { ok: false, message };
        }
      }),

    uninstall: (pluginName, options) =>
      exclusive(t('opUninstall', { name: pluginName }), () => uninstallOne(pluginName, options)),

    serviceDependents: dependentsOf,

    registry,

    settled: () => current,
  };

  /**
   * 卸载：服务层各道闸 + npm uninstall。
   *
   * 闸放服务层而非 HTTP 路由——本服务对外公开，任何插件都能绕过路由直接调
   * （与 `buildUpdateSpecs`、`isRegistryDep` 同一理由）。前端早就有正确策略
   * （只给 plugin/interface 卡片渲染卸载按钮），但那只是客户端校验，服务端不设防。
   */
  async function uninstallOne(
    pluginName: string,
    { removeConfig = false }: UninstallOptions = {},
  ): Promise<{ ok: boolean; message: string | TextRef }> {
    const bad = validatePackageSpec(pluginName);
    if (bad) return { ok: false, message: bad };

    const root = deps.projectRoot();
    const meta = await readJson(`${root}/node_modules/${pluginName}/package.json`);
    if (!meta) {
      return { ok: false, message: t('noPackageJson', { name: pluginName }) };
    }

    // ── 闸一：类型 ──
    // 市场管的是**插件**。core / runtime / api / schema / util 不是插件，不在本工具职权内。
    // 这不是「权限不够」——owner 权限很高，走 `npm uninstall` 随时能删。这道闸拦的是
    // 「**这个操作会把你用来撤销它的那条通道一起销毁**」：卸掉插件，实例照常跑、市场里点
    // 一下就能装回来（带内可恢复）；卸掉内核或宿主，实例起不来、市场随之消失，只能开
    // shell 修（带外）。更新不在此列——它保留实例且失败会自动回滚。
    // 判据与安装同一份（nonMarketKind）。
    const kind = nonMarketKind(meta.keywords);
    if (kind) {
      return {
        ok: false,
        message: t(kind === 'core' || kind === 'runtime' ? 'uninstallVital' : 'uninstallPruned', {
          name: pluginName,
          kind: KIND_NAMES[kind],
        }),
      };
    }

    // ── 闸一之二：承载「撤销通道」的服务提供者不能被卸掉 ──
    //
    // 与内核/宿主同一条判据的另一半：**这个操作会把你用来撤销它的通道一起销毁**。
    // 市场页要能用，靠三样东西同时在：`webui-client`（页面本身）、`webui-server`（托管它
    // 并提供 HTTP 面）、`package-manager`（装卸能力本身）。少任何一样，用户就只能开 shell。
    //
    // 判据是**「谁在提供我此刻依赖的服务」而不是包名**——第三方换个实现照样受保护，
    // 而 `services.all` 的首个条目即当前生效者（偏好 > 优先级 > 注册顺序），
    // webui-server 与 package-manager 都是用包名做实例 id 的插件。
    //
    // 只拦「当前生效的那个」：想换实现的正常路径是「装新的 → 切过去 → 再卸旧的」，
    // 那时它已不是提供者，本闸自然放行。
    const lifeline = deps.recoveryChannelProviders();
    if (lifeline.includes(pluginName)) {
      return { ok: false, message: t('lifeline', { name: pluginName }) };
    }

    // ── 闸二：来源 ──
    // 只有根依赖里以 semver 范围声明的才归市场管。workspace: 是用户自己的源码（删了不可逆，
    // 且多半在 git 里）；file:/link: 指向本地目录；git/URL 是外部源；不在根依赖里的是传递依赖。
    const rootPkg = await readJson(`${root}/package.json`);
    const request = ((rootPkg?.dependencies ?? {}) as Record<string, string>)[pluginName];
    const origin = classifyDepSpec(request);
    if (origin !== 'registry') {
      const why: Record<Exclude<DepOrigin, 'registry'>, TextRef> = {
        workspace: t('originWorkspace'),
        link: t('originLink'),
        git: t('originGit'),
        alias: t('originAlias'),
        transitive: t('originTransitive'),
      };
      return { ok: false, message: t('notFromMarket', { name: pluginName, why: why[origin] }) };
    }

    // 名字被宿主直接登记的插件占着时只卸包：不卸实例、不过服务依赖者闸、不整理配置
    const held = heldByHost(pluginName);
    const instanceIds = held ? [] : instanceIdsFor(pluginName);

    // ── 闸三：服务依赖者 ──
    // 某服务没有别的插件正在提供时，卸掉它的提供者会打断 required 该服务的插件（已禁用的不算）。
    // 与市场卸载前的预警同一份判定（serviceDependents）。
    const dependents = dependentsOf(pluginName);
    if (dependents.length > 0) {
      return { ok: false, message: t('breaksDependents', { dependents }) };
    }

    try {
      const snapshot = await snapshotProject(root);
      if (!Array.isArray(snapshot)) return { ok: false, message: snapshot };
      const stopped = await npmOnTree(['uninstall', pluginName, '--no-audit', '--no-fund'], root, snapshot);
      if (stopped) return { ok: false, message: stopped };
      // 从运行时注册表彻底移除（dispose + delete），幂等。卸的可能正是本插件选中的提供者，本激活随之关闭时不再等
      for (const id of instanceIds) await untilClosing(deps.unloadPlugin(id));
    } catch (err) {
      return { ok: false, message: textOf(err) };
    }
    log.info(`${pluginName}: 已从根依赖与 node_modules 移除`);
    if (held) return { ok: true, message: t('uninstalledNameTakenByHost', { name: pluginName }) };
    // 包已经卸掉了，配置文件没写成不改变这一点：回执照样 ok，写明原因与残留
    try {
      await deps.cleanupConfig(instanceIds, removeConfig);
    } catch (err) {
      return {
        ok: true,
        message: t(removeConfig ? 'uninstalledConfigUnsaved' : 'uninstalledFlagUnsaved', {
          name: pluginName,
          error: textOf(err),
        }),
      };
    }
    return {
      ok: true,
      message: t(removeConfig ? 'uninstalledConfigRemoved' : 'uninstalledConfigKept', { name: pluginName }),
    };
  }
}

export default definePlugin({
  name: '@aalis/plugin-package-manager',
  displayName: t('displayName'),
  subsystem: 'system',
  provides: [packageManager],
  uses,
  apply(caps) {
    caps.provide.use(packageManager, createService(caps), { label: 'package-manager' });
  },
});

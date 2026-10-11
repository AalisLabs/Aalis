# api-reach — 触及契约

**包名**: `@aalis/api-reach`  
**源码**: `packages/api-reach/src/index.ts`  
**实现**: 纯函数与类型，`reach` 服务由 [`@aalis/plugin-reach`](../plugins/plugin-reach.md) 提供；凭据只由它构造

## 概述

触及回答「这一次工具调用最多能碰本机的什么」。先按发起这一轮的主体与会话的房间类别定上限：只有 owner 在受众只有 owner 的会话（房间类别 `owner-only`，见 [api-session-manager](./api-session-manager.md#会话)）里有本地效果，群、别人的私聊与内部会话一律没有，owner 在群里也一样。有本地效果的，再按档位收窄、按污点把送出会话的动作改成问；子任务另与父会话实时的触及取较小值。

本包有类型、纯函数与服务描述符：

- 档位与越界策略，经 declaration merging 成为会话设置的两个键；
- `resolveReach` 解析出一份触及，`judgeReach` 判一个目标放行、问或拒；
- `protectedLists` 生成三张清单（宿主控制面、持久化与自动执行落点、拒读清单），`matchesRule` 判一个路径落不落在某条规则里；
- `sandboxPolicyOf` 按触及生成沙箱策略；
- 触及凭据 `ReachCredential` 的类型与品牌符号；
- 触及服务 `reach`：按一次工具调用签发凭据，存会话的污点与白纸的来源账本。

工具、存储、沙箱与审批还没有接入凭据：现有工具不取凭据，存储与沙箱不认它，`require` 遇到要问的目标一律判不行（回「这里没有可用的审批」）；装上触及插件不改变现有工具的行为。下文写到这些接线的地方，是接入时遵守的约定。

路径一律是真实路径：符号链接已解开；目标不存在时，取最近存在的祖先的真实路径，再接上后面不存在的各段（只交祖先本身的话，新建的落点文件按名字匹配不上）。由调用方取好再交进来。macOS 与 Windows 上比较不分大小写，Windows 上反斜杠按斜杠比较。

## 档位与越界策略

```ts
const ACCESS_TIERS = ['readonly', 'confirm', 'workspace', 'full'] as const; // 从低到高
type AccessTier = (typeof ACCESS_TIERS)[number];
type BoundaryPolicy = 'ask' | 'deny';

// declaration merging 进 @aalis/api-session-manager 的 SessionConfig
interface SessionConfig {
  accessTier?: AccessTier;
  accessOnBoundary?: BoundaryPolicy;
}
```

owner 在干净的会话里：

| 档位 | 读 | 不问就能写 | 执行 | 联网 | 要问的 |
|---|---|---|---|---|---|
| 只读 `readonly` | 全机减拒读清单 | 本会话临时区 | 沙箱内 | 问 | 其余写入、宿主执行、联网、写落点 |
| 修改确认 `confirm` | 同上 | 无 | 宿主上，每次问 | 不问 | 每一次写与执行、写落点 |
| 工作区 `workspace` | 同上 | 场所的主目录与白纸、附加可写目录、本会话树建的 worktree、仓库的 git 目录、本会话临时区、技能目录 | 沙箱内 | 不问 | 范围外的写、宿主执行、写落点 |
| 全权 `full` | 同上 | 全机减宿主控制面 | 宿主上 | 不问 | 不问；写落点照写，另记审计 |

- 宿主控制面任何档位都拒写，不可申请；拒读清单在任何档位都约束工具边界，沙箱里同样读不到；在宿主上执行的命令（全权、修改确认，以及批准过的宿主执行）约束不到。
- 越界策略为 `deny` 时，只读与工作区档要问的一律直接拒；修改确认档不受越界策略影响，它本身就是逐步确认。
- 受污染（会话读进过别人写的内容）时，全权以外的档位把送出会话的动作改成问：模型给的任意网址、要联网的命令、写技能目录、写编排定义。其余照常，插件固定的服务商（只收查询词的搜索之类）也照常。全权没有任何变化。

## 解析与判定

```ts
type ReachPrincipal = 'owner' | 'other' | { subtaskOf: Reach };

interface ReachInput {
  principal: ReachPrincipal;
  roomClass: RoomClass;                 // 子会话取根会话的
  tier: AccessTier;                     // 生效的档位与越界策略，子会话取根会话的
  onBoundary: BoundaryPolicy;
  tainted?: readonly string[];          // 读进过谁的内容（来源称呼）；不给或为空即干净
  place: { home: string; paper: string }; // 场所的主目录与白纸
  binding?: { extraRoots: string[]; worktrees: string[] };
  gitDirs: readonly string[];           // 绑定所在仓库的 git 目录（common dir）
  sessionTmp: string;                   // 本会话临时区
  othersContent: readonly string[];     // 别人场所的白纸与来源账本里的文件
  localPorts: readonly number[];        // 沙箱里拒连的本机端口
  lists: ProtectedLists;
  paths: HostPaths;
}

function resolveReach(input: ReachInput): Reach;   // { exec: 'none' } 或 LocalReach
function judgeReach(reach: Reach, request: ReachRequest): ReachDecision;
```

**上限**：主体为 `owner`、房间类别为 `owner-only` 时才有本地效果，`exec` 按档位为 `sandbox`（只读、工作区）或 `host`（修改确认、全权）。其余组合的触及是 `{ exec: 'none' }`：读写执行一律拒（`no-local-effect`），联网放行，交给工具的资格轴（分组闸与等级）管。

**子任务**：主体写 `{ subtaskOf: <父会话实时的触及> }`。父会话没有本地效果时子任务也没有；否则档位取两者较低的，越界策略任一为 `deny` 即 `deny`，污点并上父会话的来源。子任务写的是它自己的临时区。

**这份触及的落点**：`LocalReach.lists` 是输入的三张清单，落点另按 `gitDirs` 补上两类：git 目录不一定叫 `.git`（裸仓库加 worktree、`--separate-git-dir`），每个 git 目录本身与它里面的落点（见下文「三张清单」的 git 一条）照样拦；把目录伪装成裸仓库少不了的 `HEAD` 是落点，`.git` 与这些 git 目录里的除外。

**要判的目标**：

```ts
type ReachRequest =
  | { effect: 'read' | 'write'; path: string }
  | { effect: 'write'; workflow: string }            // 一份编排定义，按 id
  | { effect: 'exec'; host: boolean }                // host：要在沙箱外执行
  | { effect: 'network'; via: 'url' | 'command' | 'provider' };
```

**判定**：放行；问（带原因）；拒（带规则）。

```ts
type ReachAskReason =
  | { kind: 'tier' }                                                  // 修改确认档
  | { kind: 'boundary'; target: 'write-path' | 'host-exec' | 'network' } // 越界
  | { kind: 'landing' }                                               // 写落点
  | { kind: 'outbound' };                                             // 受污染后送出会话

type ReachDecision =
  | { verdict: 'allow'; landing?: true }            // 全权写落点带 landing：写入并记审计
  | { verdict: 'ask'; reason: ReachAskReason }
  | { verdict: 'deny'; rule: 'no-local-effect' | 'control-plane' | 'deny-read' } // 不可申请
  | { verdict: 'deny'; rule: 'boundary-policy'; reason: ReachAskReason };       // 越界策略为拒
```

写一个路径依次看：宿主控制面（拒）→ 落点（全权放行并带 `landing`，其余问）→ 技能目录（受污染时问 `outbound`）→ 全权放行 → 修改确认问 → 在不问就能写的根里放行 → 其余为范围外写。读只看拒读清单，本会话临时区总读得到。

## 三张清单

```ts
type PathMatcher = { path: string } | { pattern: string };    // path：这个路径与它下面的全部；pattern：对整条路径的正则
type PathRule = PathMatcher & { except?: readonly PathMatcher[] };

function protectedLists(input: {
  paths: HostPaths;
  userHome: string;
  platform: NodeJS.Platform;
  form: 'source' | 'npm';
  codeDirs: readonly string[];
  entry?: string;
}): ProtectedLists;
function withRealRoots(lists: ProtectedLists, realOf: (path: string) => string | undefined): ProtectedLists;
function matchesRule(rule: PathRule, path: string, platform: NodeJS.Platform): boolean;
```

`form` 是安装集的形态：源码形态下有 `packages/`，npm 形态是 create-aalis 生成的项目（家目录在安装集里）。`codeDirs` 是安装集以外、守护进程加载了代码的目录（如经链接装进来的插件）。`entry` 是守护进程的入口文件（启动脚本的真实路径），取不到时不给。正则只用锚点、字符类、分组与选择、量词，沙箱的生成器要能翻译。

`withRealRoots` 按真实路径补上链接出去的根：以具体路径为根的规则（`{ path }`），根的路径上有符号链接、`realOf` 给出的真实路径与写法不同时，按真实路径再加一份同样的规则，根下的例外随根挪过去；按正则写的规则不动。真实路径要碰文件系统，由调用方在激活时取好（触及插件），之后链接改指向不跟踪。主配置与 `secrets.yaml` 在宿主控制面（`secrets.yaml` 另在拒读清单）里各单列一条，为的是它们链接到别处时能以它们为根补上。

**宿主控制面**（`control`，一律拒写，不可申请）：

- 家目录下除白纸（`stage/paper`）、临时区（`tmp`）、技能目录（`self/skills`）以外的全部：插件状态、主配置、`secrets.yaml`、日志、`run`、`cache`、人设卡、编排定义（只经定义工具写入）、公开区（只经发布插件写入）；
- 守护进程加载的代码：安装集的 `node_modules`、`dist`，源码形态下各包的 `dist` 与 `node_modules`，以及 `codeDirs`。源码本身不在内；
- npm 形态下另有守护进程的入口文件（`entry`）与安装集的 `package.json`（插件发现读它的依赖）。源码形态下它们是在改的源码，不在内。

**持久化与自动执行落点**（`landing`）：

- git：`.git` 本身（目录形式的，与子模块工作树里文件形式的），它里面的 `hooks/**`、`config`、`config.worktree`、`commondir`（git 把它指向的目录当共用目录，配置与钩子都从那里取）、整棵 `modules/**`（子模块的名字可以带斜杠、可以嵌套，按目录名列不全），`worktrees` 与 `worktrees/<名>` 这两级目录本身及其下的 `config.worktree`、`commondir`。代价是沙箱里的 `git worktree add`、`git worktree prune` 与子模块的拉取、检出写不了这些地方，要宿主执行。伪装裸仓库的 `HEAD` 与不叫 `.git` 的 git 目录由触及按它的 git 目录补上（见上文「这份触及的落点」）；
- shell 与登录：各 shell 的 rc 与 profile 文件、`~/.config/fish`、`~/.ssh`、`~/.gitconfig`、`~/.config/git`；macOS 的 `~/Library/LaunchAgents`，Linux 的 `~/.config/systemd/user` 与 `~/.config/autostart`；
- 项目里会被工具自动执行的配置：`.envrc`、`.vscode/tasks.json`、`.vscode/settings.json`、`*.code-workspace`、`.husky/**`、`.pre-commit-config.yaml`，以及其他代理与编辑器的可执行配置（`.claude/settings.json`、`.claude/settings.local.json`、`.mcp.json`、`.cursor/` 下的 `hooks.json` 等五个、`.codex/` 下的 `config.toml`、`rules/` 与 hooks）；
- 项目指令 `AALIS.md`、`AGENTS.md` 与项目级 `.aalis/`（实例家目录自己叫 `.aalis` 时不算，但它里面再出现的，如白纸里项目的 `.aalis/`，照样算）；
- 装着上面这些的目录本身：`.vscode`、`.claude`、`.cursor`、`.codex`，用户家目录下的 `~/.config`（Linux 另有 `~/.config/systemd`，macOS 另有 `~/Library`）。改名只核源与目标两条路径，不核被搬动目录里的子孙；先在别处摆好整棵子树再改名到位，目标就是这些目录之一，照样拦下。

**拒读清单**（`denyRead`）：

- 家目录下除舞台（`stage/`）与 `self/` 两个目录整个、日志与主配置以外的全部，包括别的会话的临时区；本会话临时区由触及按会话放回；
- 同一用户下其他实例的家目录（`~/.aalis` 与 `~/.aalis-*` 中本实例以外的；用 `--home` 放在别处的实例覆盖不到）；
- 凭据文件：`~/.ssh`、`~/.aws`、`~/.config/gh`、`~/.gnupg`、`~/.npmrc`、`~/.netrc`、`~/.git-credentials`、`~/.docker/config.json`、`~/.kube/config`，macOS 的 `~/Library/Keychains`；
- 任何目录下的 `.env*`，豁免 `.env.example`、`.env.sample`、`.env.template`；舞台等放行的地方里的 `.env*` 照样拒读；
- macOS 与 Linux 常见浏览器的配置与数据目录（macOS 上 Edge 的 Beta、Dev、Canary 各有独立目录，Linux 含 Snap 与 Flatpak 装的）。

用户家目录是根目录（容器里没有 passwd 条目的用户，HOME 常是 `/`）时照样生成 `/.ssh` 这类路径。

拒读不限制写：工作区档照样能写项目里的 `.env`。别人场所的白纸不在拒读清单里：文件工具读得到（读了计污点），干净回合的沙箱读不到。

## 沙箱策略

```ts
interface SandboxPolicy {
  readDeny: readonly PathRule[];        // 拒读清单
  readAllowWithin: readonly string[];   // 拒读之后放回：本会话临时区
  provenanceDeny: readonly string[];    // 干净回合里别人的内容：拒读拒写，排在一切放行之后；受污染时为空
  write: readonly string[];             // 可写的根，含这条命令批准过的范围外写
  writeDeny: readonly PathRule[];       // 落点拒写；受污染时另拒技能目录（批准过的那几处除外）
  writeExceptions: readonly PathRule[]; // 拒写之后放回：锚定在可写范围各根下的 node_modules，与按落点批准过的确切路径
  controlDeny: readonly PathRule[];     // 宿主控制面拒写，排在所有放行与例外之后
  network: 'off' | 'on';                // on：IP 出网，减去 localPorts
  localPorts: readonly number[];
  unixSockets: readonly string[];       // 可连的 unix socket 所在目录：可写范围与本会话临时区
}

interface SandboxGrants {
  writePaths?: readonly string[];   // 按范围外写、或受污染时写技能目录批准的路径
  landingPaths?: readonly string[]; // 按落点批准的路径
  network?: boolean;
}

function sandboxPolicyOf(reach: Reach, grants?: SandboxGrants): SandboxPolicy;
```

各段的先后（后面的压过前面的），沙箱的生成器照这个顺序翻译：

- 读：默认可读 → `readDeny` 拒 → `readAllowWithin` 放回 → `provenanceDeny` 拒；
- 写：默认拒 → `write` 放 → `writeDeny` 拒 → `writeExceptions` 放回 → `controlDeny` 拒 → `provenanceDeny` 拒。

只有命令在沙箱里执行的触及（只读、工作区档）有沙箱策略，其余调用 `sandboxPolicyOf` 抛错。工作区档干净时开网，受污染时断网、写入照常（技能目录除外）；只读档断网。

`grants` 是这条命令批准过的提权，按批准时的原因分开放，批准一个目录不连带放回它下面的落点：

- `writePaths`：并进可写的根，其下的落点照样拒写。其中落在技能目录里的（受污染时写技能本身批准的）另从技能目录的拒写里放回，装着技能目录的范围外目录不算；
- `landingPaths`：在拒写之后只放回那一个确切路径，不含它下面的；
- `network`：受污染或只读档里批准过的联网。

宿主控制面与别人的内容批准了也不行。

## 凭据

```ts
const REACH_CREDENTIAL: unique symbol; // Symbol.for('@aalis/api-reach/credential')

interface ReachCredential {
  readonly [REACH_CREDENTIAL]: true;          // 不可枚举
  readonly tainted?: readonly string[];      // 读进过谁的内容；全权档不带
  readonly exec: 'none' | 'sandbox' | 'host';
  readonly home?: string;    // 场所的主目录：当前目录没有值时取它
  readonly paper?: string;   // 场所的白纸：不写输出位置的工具产物写进这里
  require(request: ReachRequest): Promise<ReachVerdict>;      // 要问时经审批服务问
  allows(effect: 'read' | 'write', realPath: string): boolean; // 存储兜底，含这次调用批准过的一次性目标
  sandboxPolicy(): SandboxPolicy;                             // 带上这次调用批准过的提权
  processEnv(mode: 'sandbox' | 'host'): Promise<Record<string, string>>;
  noteWrite(realPath: string): void;                          // 经凭据写进白纸时调用
}

type ReachVerdict = { allowed: true } | { allowed: false; message: string };
function isReachCredential(value: unknown): value is ReachCredential;
```

凭据按一次工具调用签发，只由触及插件构造；工具从调用上下文取得后转交给存储与沙箱，不自己拼。存储服务与沙箱用 `isReachCredential` 认凭据，不带品牌符号的对象一律当作没有凭据处理。品牌符号登记在全局符号表里，进程里装了两份本包时也认得；它只在本包与触及插件里出现（守卫 `test/architecture/reach-credential.test.ts`），凭据上的品牌不可枚举，展开或 `Object.assign` 复制出来的对象不带它。品牌防的是漏传、误传：第一方包由守卫禁止拼凭据，插件是可信代码，进程内蓄意伪造挡不住。

- `exec`、`home`、`paper`、`tainted` 按签发时的触及；`require`、`allows`、`sandboxPolicy` 与 `noteWrite` 每次按会话当时的设置与污点重算，签发之后降档或受污染立即生效。
- `tainted` 给执行面闸填进审批的来源；全权档不带，全权不提示，确认卡上也不写来源。

- `require` 判不行时，`message` 写明要做什么、为什么不行、能不能申请；宿主控制面与拒读清单写明不可申请。
- `processEnv`：子进程环境只从凭据来。`host` 是 owner 的 login shell 环境；`sandbox` 在它之上去掉凭据并注入沙箱要的几项（见 [plugin-reach](../plugins/plugin-reach.md#子进程环境)）。没有本地效果的凭据抛错。
- `sandboxPolicy` 只在 `exec` 为 `sandbox` 时可取，其余抛错。

## 服务

```ts
interface ReachService {
  forCall(call: OriginTurn): Promise<ReachCredential>;
  markTainted(sessionId: string, sources: readonly string[]): void;
  provenanceOf(realPath: string): ProvenanceRecord | undefined;
}

interface ProvenanceRecord {
  sessionId: string;            // 写入它的会话
  sources: readonly string[];   // 写入时这个会话读进过谁的内容
  at: number;
}

const reach = defineService<ReachService>('reach');
```

- `forCall`：按一次工具调用签发凭据。`OriginTurn` 是 api-authority 判发起类别要的回合信息（会话、平台、发言者、授权身份、入站回合），与执行守卫上下文同一口径。没有本地效果的调用拿到 `exec` 为 `none` 的凭据。
- `markTainted`：记下这个会话读进了别人写的内容。来源称呼至少一个、不能是空白，否则抛错；粘在会话上，之后签发的凭据都带着。
- `provenanceOf`：来源账本里白纸上一个文件（真实路径）的记录。受污染的会话经凭据写进白纸的文件才有记录，没有记录的按 owner 写的算。

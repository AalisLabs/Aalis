# @aalis/runtime —— 独立部署运行时（Node 宿主层）

## 它是什么

Aalis 把「内核」和「宿主」分开：

- **`@aalis/core`** = **环境无关内核**。不碰 I/O、不读 `process.env`、不知道 node_modules，
  环境专有件（重启策略、时钟、版本号等）经 `AppOptions` 注入；插件定义与各实例配置由宿主登记时交来（设计理念见 docs/core）。
- **`@aalis/runtime`** = **Node 宿主层**。用 Node API 承担 core 刻意不做的几件事
  （插件发现 / 配置文档 / 重启策略），并提供「一行启动」`startAalis`。

core 是环境无关的逻辑，runtime 是承载它的 Node 实现。要在 Deno / 浏览器 / 嵌入环境中运行，
**另写一个宿主包**实现同样契约即可，core 与各插件契约保持不变（忒修斯之船）。

## Node 专属性 ≠ 包管理器

- runtime 用 `node:fs / module / child_process / process` + 读 `node_modules`，所以它绑定的是
  **Node.js 这个 JS 运行时**。
- **与包管理器无关**：`npm` / `pnpm` / `yarn` 都能用——它们都产出 `node_modules`，runtime 从
  **项目根**沿 `node_modules` 逐级上溯定位插件包（取真实路径），因此 **npm 扁平 / pnpm 隔离 /
  monorepo 软链** 三种 `node_modules` 拓扑都自洽。
- 区分轴：runtime 名字里的「node」指 **JS 运行时**（Node vs Deno vs 浏览器），不是包管理器
  （npm/pnpm 都属 Node 生态）。将来若出现别的环境宿主，可加后缀（如 `@aalis/runtime-deno`）；
  当前 `@aalis/runtime` = 默认/参考 Node 宿主。

## 设施（exports）

| 导出 | 作用 |
|---|---|
| `startAalis(opts?)` | **一行启动**：解析家目录 → 读家目录里的 `aalis.config.yaml` 与 `secrets.yaml` → 组装 `App` 并接上宿主路径与配置文档 → 从安装集的 `node_modules` 发现并登记已装插件 → 启动 + 挂 SIGINT/SIGTERM 优雅退出 + 进程级重生。返回 `App`。家目录见「家目录」一节，装配顺序见「startAalis 的装配顺序」。 |
| `createNodeModulesPluginLoader(appDir)` | **独立部署**插件加载器：读安装集（绝对路径）`package.json` 的 `dependencies`+`optionalDependencies`，按 `isLoadablePlugin`（**唯一标准：`keywords` 含 `aalis-plugin`**；契约 `aalis-api`/前端 `aalis-interface`/核心 `aalis-core`/工具链 `aalis-runtime`/工具库 `aalis-util` 因不带该词自然排除，无名前缀/service/subsystem 回退、无 marker 排除）发现并动态 import。包目录按 `node_modules` 逐级上溯定位，入口按 `import()` 的规则解析（`exports` 取 `"."` 的 import 条件目标，没有 `exports` 时按 `main`）。 |
| `createFsPluginLoader(packagesDir)` | **monorepo 自托管**加载器：扫给定的 packages 目录（绝对路径，本仓库入口传 `<仓库>/packages`），复用同一 `aalis-plugin` 纯关键词正向门。 |
| `createPluginDiscovery(app, loader, store)` | 发现驱动：`loadAll()` 发现并导入全部插件，按配置存储取各实例的配置（解析密钥引用后）与禁用标记（含 `name:suffix` 实例），整批交给 `app.pluginAll`，返回时已静置；`rescan()` 登记新出现的插件与配置里尚未注册的 `name:suffix` 实例，返回本次新登记的主实例名（定义名），即 `plugin-source` 服务的实现；`registerConfiguredInstances()` 只登记配置里尚未注册的 `name:suffix` 实例（模块取注册表里该模块在册实例的定义，主实例优先；主实例已卸载时取同模块其它在册实例的），供配置热重载调用。加载器契约 `PluginLoader`（`discover` / `load` / 可选 `reload`）由本包导出。 |
| `createFsYamlConfigProvider(configPath)` | 文件系统 + YAML 配置 provider（`configPath` 为绝对路径；返回 `{config, provider}`，交给 `createConfigStore`）。 |
| `createFsSecretsProvider(secretsPath)` | 文件系统 + YAML 密钥存储（`secretsPath` 为绝对路径，`startAalis` 传家目录里的 `secrets.yaml`；返回 `{values, provider}`，作为 `createConfigStore` 的第三个参数）。读写、拒写与监听同配置文件；文件不存在时按空映射处理、第一次保存时建出；临时文件一律以 0600 创建。类型 `SecretProvider`、`SecretStoreInit` 由本包导出。 |
| `parseHostArgs` / `resolveHome` / `derivePaths` / `isHomeInitialized` / `initHome` | 家目录的解析、路径派生与初始化，`startAalis` 用的就是这一套；参数有误时抛 `HomeArgsError`。 |
| `createConfigStore(initial, provider?, secrets?)` | 配置文档：内存态加危险键闸，读写方法与 `HostConfig` 相同；落盘委托给 `provider.save`（不提供表示宿主不持久化，保存立即兑现、不写盘），外部变更经 `provider.watch` 接入。`secrets`（`{ values, provider? }`）是密钥存储：给了才把密钥字段拆进它、文档里只留引用，`resolvePluginConfig(id, schema)` 把文档形态解析成交给 core 的配置；落盘时先写密钥再写文档。不给时密钥照旧以明文留在文档里。本身不碰文件。 |
| `installHostConfig(app, store, opts?)` | 把文档作为 `host-config` 服务独占登记在根激活上，并应用文档里的服务偏好。`opts` 传交给配置同步的同一份，`host-config` 的 `trimUnknownFields` 据此声明宿主的裁剪政策（缺省为裁剪）。插件拿到的 `save()` 兑现即已落盘（宿主不持久化时立即兑现、不写盘），失败以拒绝传出并已记一笔日志（拒写记告警，其它记 error）；`applyPluginConfig` 在这里实现，插件拿到的 `setPluginConfig` 拒收密钥字段上的明文。须在登记任何插件之前调用。 |
| `withPluginConfigSync(loader, app, store, opts?)` | 加载政策：包装加载器，导入定义后、登记前把 `configSchema` 派生的默认值深合并进文档，默认裁剪 schema 外字段，并把密钥字段上的明文移进密钥存储。返回 `{ loader, finishInitialLoad }`，首次加载批次在 `finishInitialLoad()` 时合并为一次落盘。 |
| `syncPluginDefaults` / `handleConfigChanged` / `installConfigHotReload` | 同一政策的其余入口，参数为 `(app, store, opts?)`，后两者在 `store` 之后另收发现驱动 `discovery`：为已登记实例补默认值并裁剪；处理外部变更（文件里已没有配置段的后缀实例卸载，其余实例解析后的配置与运行态有差异的经 `updateConfig` 重建（禁用插件只换配置、保持禁用），新出现的后缀实例经 `discovery.registerConfiguredInstances()` 登记）；接管变更监听，在 `app:stopping` 时停止。 |
| `createProcessRespawnStrategy({ appDir })` | 进程级重启策略（`app.restart()` → 子进程重生；开发模式在安装集里找本地 tsx）。 |
| `createServiceRestartStrategy()` / `SERVICE_RESTART_EXIT_CODE` | 服务形态的重启策略：停掉 App 后以 75 退出，由服务管理器拉起（见「实例锁」的服务形态重启）。 |

`startAalis` 的 `opts`：`appDir`（安装集，绝对路径，缺省 `<家目录>/app`）、`defaultHome`（宿主代码给的兜底家目录，绝对路径）、`pluginLoader`、`consoleSink` / `fileLog` / `terminalRestore`（默认开）、`argv`（默认 `process.argv.slice(2)`）、`devMode`、`configSync`。

文件日志写家目录的 `logs/latest.log`，`fileLog: false` 关掉。启动时先轮转旧日志：上一轮的改名为
`latest.1.log`（编号插在扩展名前），已有的依次后移，保留 5 份，更早的删除。每次守护进程启动都算一轮，
`/restart`、市场更新引起的重启与更新失败后的回滚重启也各算一轮。轮转失败不影响启动：照旧覆盖写
`latest.log`，并记一条告警写明原因。不接在原内容后面写，是因为一个文件只装一轮、seq 随文件位置单调递增，
WebUI 的历史分页与 CLI 的启动恢复都依赖这一点。

`startAalis` 在加载器导入定义后、Core 注册之前同步插件配置：从 `configSchema` 补齐默认值，
默认裁剪未知字段，再让首次 `apply` 读取该配置。主实例与已配置的复用实例使用同一规则；
`configSync.trimUnknownFields: false` 可保留未知字段。同一步把密钥字段上的明文移进 `secrets.yaml`、原处换成引用。首次加载批次合并为一次保存，后续市场
重扫描也在激活前同步并保存。配置热重载（`aalis.config.yaml` 或 `secrets.yaml` 被外部修改）复用相同规则，通过 `updateConfig` 重建有变更的插件（禁用插件只换配置、保持禁用，启用时按新配置激活），卸载文件里已没有配置段的后缀实例，并登记新出现的后缀实例。
直接组装 `App` 的宿主仍自行决定配置政策；Core 不解释 schema，也不替运行中的实例改配置。

## 家目录

家目录装着一个实例的全部状态：配置、密钥、数据库、日志、人设卡、技能、舞台。runtime 在启动时解析一次，之后不变；进程的 cwd 不带任何语义，`startAalis` 也不切换 cwd。覆盖顺序：

1. 命令行 `--home <目录>`；
2. 环境变量 `AALIS_HOME`；
3. `--profile <名>` 或 `AALIS_PROFILE`，得到并列的 `~/.aalis-<名>`（名字只能用小写字母、数字与连字符，以字母或数字开头，最长 32 个字符）；
4. 宿主代码传的 `defaultHome`；
5. `~/.aalis`（Windows 为 `%USERPROFILE%\.aalis`）。

`AALIS_HOME`、`AALIS_PROFILE` 设为空串时视同未设。profile 与更高优先级的 `--home` / `AALIS_HOME` 同时给出时报错退出，不静默挑一个。`--home` 与 `AALIS_HOME` 开头的 `~` 展开为用户主目录；命令行与环境变量里写的相对路径按启动时的 cwd 解析一次，之后全程用绝对路径。

profile 由家目录的路径决定：家目录是 `~/.aalis-<名>` 时就是 profile `<名>`，经 `--home` 或 `AALIS_HOME` 选中它也一样，插件按 profile 派生的名字（如 MongoDB 记忆库的库名）对同一个家目录不变。这一条按路径的写法认，不解符号链接。家目录初始化之后，交给插件的路径取真实路径：符号链接、大小写与末尾分隔符不同的写法指向同一个目录时，插件拿到的是同一个字符串。

家目录没有初始化（里面没有 `aalis.config.yaml`）就拒绝启动，只提示怎样初始化，不会静默起一个空的家。在启动命令里加上 `--init` 运行一次即可初始化：建目录（0700）、写默认的 `aalis.config.yaml` 与空的 `secrets.yaml`（0600）、建布局里的子目录，然后退出。目标目录已存在时，里面只能有布局自己的条目（`state`、`logs`、`cache`、`run`、`tmp`、`self`、`stage`、`secrets.yaml`），有其它内容（包括已初始化的家目录里的 `aalis.config.yaml`）就拒绝，不覆盖任何文件；已有的 `secrets.yaml` 保留，权限收紧为 0600。

宿主参数（`--home`、`--profile`、`--init`、`--service`）只认命令行开头的那一段，要写在子命令之前，如 `node index.mjs --home <目录> status`；写在子命令之后的归子命令，宿主不处理。开头那一段里的 `--` 跳过（`pnpm dev -- --init` 会把它原样传进来）。经 `npm start` 启动时，额外参数要放在 `--` 之后才会传给入口：`npm start -- --home <目录>`、`npm start -- --init`。

安装集（`appDir`）是放 `package.json` 与 `node_modules` 的目录，缺省为 `<家目录>/app`。这个缺省位置留给将来的全局启动器，目前还没有这样的启动器，因此实际使用时由入口显式传 `appDir`：脚手架生成的 `index.mjs` 传它所在的项目目录，本仓库的 `src/index.ts` 传仓库根。没有传自定义 `pluginLoader`、而 `<安装集>/package.json` 不存在时，`startAalis` 拒绝启动（exit 1），提示把入口文件所在的目录作为 `appDir` 传入。

解析结果作为 `host-paths` 服务（`@aalis/api-host-paths`）独占登记在根上，插件要定位安装集或家目录布局时在 `uses` 里声明它，不读 `process.cwd()`（有 architecture 守卫）。布局：

```
<家目录>/
  aalis.config.yaml            主配置，密钥字段只放引用
  secrets.yaml                 密钥的值（0600）
  state/                       实例状态：数据库、向量库、会话、附件、checkpoint、WebUI 凭据等
  state/plugins/               各插件的私有数据
  logs/                        文件日志 latest.log
  cache/                       缓存
  run/                         实例锁（以后还放 socket）
  tmp/                         临时文件
  self/personas  self/skills  self/workflows   人设卡、技能、编排定义（编排定义目前仍在 workspace/workflows，见下）
  stage/paper  stage/public    白纸成品、发布的作品
  stage/drafts                 草稿，目前未使用
  workspace/                   文件工具的工作根（用户根，激活时建出）
```

`self/workflows` 暂未使用：plugin-workflow 的 `defsDir` 仍是 `workspace:/workflows`，迁到 `workflows:/` 随工作会话的第二切片一起做。

插件经 `@aalis/plugin-storage-local` 的内部根访问这些目录：`state/` 是 `data:/`，`state/plugins/` 是 `pluginData:/`，`tmp/`、`cache/`、`logs/` 分别是 `tmp:/`、`cache:/`、`logs:/`（`logs:/` 只读），`self/` 下三个目录是 `personas:/`、`skills:/`、`workflows:/`，`stage/paper` 与 `stage/public` 是 `paper:/` 与 `public:/`。内部根的位置不能配置；`stage/drafts` 还没有对应的根，`run/` 归 runtime 自用；`workspace/` 是 `roots` 配置里缺省的那个用户根。见 [plugin-storage-local](../plugins/plugin-storage-local.md)。

`secrets.yaml` 是「键 → 值」的映射，存 schema 里 `secret: true` 的字段的值，`aalis.config.yaml` 里只写引用 `{ $secret: '<键>' }`。runtime 启动时读它并监听改动，把配置交给插件之前解析引用；直接写进 `aalis.config.yaml` 的明文在同步插件配置时被移进来；保存时先写它、再写主配置。引用的键不在里面时记一条错误，用 `parseConfig` 读配置的插件激活失败，诊断检查 `config.secrets` 也会报出。键名、写入与清理规则见 [运行态与配置文档](../core/config.md#密钥配置)。这两个文件由 runtime 负责读写：经 storage 读写 `secrets.yaml`、改写 `aalis.config.yaml` 都会被拒绝（见 [plugin-storage-local 的「宿主控制文件」](../plugins/plugin-storage-local.md#宿主控制文件)）。

配置里写宿主文件路径的字段声明 `format: 'absolute-path'` 或 `'executable'`（见 `@aalis/schema-config`）：相对路径没有可靠的基准，一律不收。

## 实例锁

同一家目录只许一个守护进程：没有锁时，手动在终端再起一份会与服务并存，每条消息回两遍。锁放在家目录的 `run/` 里，文件名 `instance.<n>.lock`，代号 n 最大的那份是现行锁。

- **取锁**：先把完整内容写进临时文件，再 link 成下一个代号。link 在目标已存在时原子失败，同一代号只有一个进程拿得到，读到的锁内容也总是完整的；所以家目录所在的文件系统要支持硬链接（exFAT、部分 SMB 挂载不行，启动时一行报错退出）。link 成功后再看一遍更低的代号：还有活着的持有者就让出刚建的这一代并报占用，代号最低的活持有者胜出。确认之后删掉更低代号的旧文件。
- **释放**：进程退出时删掉自己这一代，只在锁文件的内容仍是自己那份时才删，同名的锁可能已是别的实例的。
- **判活**：锁里记 pid、本次开机的标识（Linux 的 boot_id、macOS 的 kern.bootsessionuuid）、pid 命名空间（Linux）、进程启动标识（Linux 是 `/proc/<pid>/stat` 的启动滴答数，其它 POSIX 是 UTC 下的 `ps -o lstart=`）与交接令牌的哈希。这些都与墙上时钟无关，NTP 步进时钟、夏令时回拨都不影响判断。开机标识不同判残留；pid 命名空间不同（另一个容器共用这个家目录）判不了，按占用处理；pid 不在、或启动标识不同（pid 被复用）判残留。SIGKILL 或服务管理器超时强杀留下的锁，下次启动时按残留接手。
- **查不了启动标识的平台**：Windows 与没有 `ps` 的精简 Linux 镜像只看 pid。强杀留下的锁、pid 又恰好被别的进程占用时，启动会一直报占用；确认没有实例在运行时删掉报错里点名的锁文件即可。
- **被占用**：打印占用者的 pid 与锁文件后以 1 退出，不碰正在用的日志。以 `--service` 启动（服务单元带上）时以 0 退出：配合 launchd 的 `KeepAlive={SuccessfulExit=false}`，不会每隔几秒被拉起、抢锁失败地循环。锁文件读不了（权限）时不猜它是残留，报错退出。
- **前台重启的交接**：取锁时生成一个随机令牌，锁里只记它的哈希。`/restart` 与市场更新引起的前台重启，把令牌经环境变量 `AALIS_LOCK_HANDOFF` 交给新进程；新进程看到锁里的哈希对得上就接手，并立即把它从环境里删掉，不让插件起的子进程与侧车继承。
- **服务形态的重启**：以 `--service` 运行时，`/restart` 与市场更新停掉 App 后以 75 退出，由服务管理器（launchd 的 KeepAlive、systemd 的 `Restart=on-failure`）拉起新进程；不自己起新进程，否则它会脱离服务管理器的监管。服务形态下没有「新版起不来就回滚」，市场更新照常退出并记一条说明。
- **子命令不取锁**：子命令是一次性实例，与守护进程并存是预期的。
- **只有 `startAalis` 取锁**：自己组装 App 的宿主不经过这一步，需要时自行保证同一家目录只起一份。

## 子命令

子命令分发是默认行为：argv 非空即子命令模式——`node index.mjs <name> [args]` 等价于聊天里的
`/<name> args`，在 `app.start()` 之前短路执行并退出；首项不是已注册命令时报错退出（exit 2）。两种情况
都不会启动守护进程（打错的命令名若照常起守护，就是与运行中实例并存的第二个实例）。argv 为空才进守护进程。
`argv` 只用于宿主自己解析命令行的场合，传显式数组（`[]` 即守护进程），默认 `process.argv.slice(2)`；开头的宿主参数照样先取走。

子命令进程是完整加载全部插件、但与正在运行的守护进程零通信的一次性实例，由此有三条边界：

- 不写 `logs/latest.log`，也不轮转（否则会把守护进程正在写的日志改名移走）；日志走 stderr，stdout 只有命令结果，便于脚本消费；
- 没有重启能力：不注入重启策略，`restart` 子命令返回「不可用」而非重启守护进程；
- `status` / `shutdown` 只作用于这个临时实例。写数据的指令按数据落在哪分两类：落在 `aalis.config.yaml`
  的（如 `auto`）经保存触发守护进程的配置热重载，会生效；落在各插件自己内存态并各自落盘的
  （如 `level` 的等级表、`session.*` 的会话覆盖）在守护进程运行期间不会对其生效，且可能被守护进程下次落盘
  覆盖。管理运行中的实例请用聊天指令 / TUI / WebUI。

它仍会完整跑一遍插件 `apply`，因此守护进程运行期间执行子命令会有两处可见副作用：端口型插件（webui-server /
mcp-server）绑定失败并打一条 error 后降级；config-sync 可能按 schema 回填 / 裁剪配置文件、把明文密钥移进 `secrets.yaml`，守护进程会因此触发一次热重载。

## startAalis 的装配顺序

0. **家目录与安装集**：解析家目录（见「家目录」），处理 `--init`，没初始化就退出；没传插件加载器而安装集里没有 `package.json` 时也退出。
1. **实例锁**：守护模式取实例锁（见「实例锁」），被占用就退出。之后才装日志 sink、写日志：第二个实例不会把正在用的 `latest.log` 轮转走。
2. **文档与密钥**：`createFsYamlConfigProvider(<家目录>/aalis.config.yaml)` 读 YAML，`createFsSecretsProvider(<家目录>/secrets.yaml)` 读密钥，`createConfigStore(config, provider, secrets)` 建配置文档。
3. **App**：`new App({ name, logLevel, restartStrategy, devMode, now, version })`，`name` 与 `logLevel` 取自文档。子命令模式不注入重启策略。
4. **host-paths 与 host-config**：在根上独占提供 `host-paths`，再 `installHostConfig(app, store, opts.configSync)`。文档里的服务偏好在全部提供者上线之前生效。
5. **加载政策**：`withPluginConfigSync(loader, app, store, opts.configSync)` 包装加载器（缺省 `createNodeModulesPluginLoader(<安装集>)`）。
6. **发现**：`createPluginDiscovery(app, loader, store)` 建发现驱动，`startAalis` 以它的 `rescan` 在根上独占提供 `plugin-source`；`loadAll()` 整批登记全部插件，随后 `finishInitialLoad()` 落盘首批规范化结果。子命令模式在此分发并退出，否则 `app.start()`。
7. **热重载**：`installConfigHotReload(app, store, discovery, opts.configSync)`，文件里新出现的后缀实例经发现驱动登记；`app:stopping` 时停止监听。

## 两种部署模型（同一套契约，两个加载器）

- **独立（纯 npm/pnpm）**：`npm create aalis@latest <dir>` 生成项目——`package.json` 含所选 @aalis 插件、
  `index.mjs`（`startAalis({ appDir: <项目目录>, defaultHome: <项目目录>/home })`）与家目录 `home/`。
  运行时 `createNodeModulesPluginLoader` 从项目的 `node_modules` 发现插件。
- **monorepo 自托管**：本仓库自身，入口 `src/index.ts` 以仓库根为安装集，从 `@aalis/runtime` 引入
  `createFsPluginLoader` 扫 `packages/`。`pnpm dev` 用仓库里的 `.aalis-dev/` 作家目录（第一次先 `pnpm dev --init`），
  从源码运行的生产实例用 `AALIS_HOME` 或缺省的 `~/.aalis`。FS 系列（`createFsPluginLoader` /
  `createFsYamlConfigProvider` / `createProcessRespawnStrategy`）只在 `@aalis/runtime` 定义一处，
  monorepo 与独立部署共用，无重复实现。

## 怎么为别的环境写宿主

core 的 `App` 构造只接收环境无关的选项（`name` / `logLevel` / `restartStrategy` / `devMode` / `now` /
`version` / `logHub` / `logger` / `disposeTimeoutMs` / `slowThresholdMs`，全部可省），插件发现与配置文档都不经它注入。
`startAalis` 从配置文件顶层读 `slowThresholdMs` 注入（改了要重启），其余时长用 core 默认值。
`@aalis/runtime` 的包入口会引入 Node 模块，非 Node 宿主不能直接复用，要用该环境的 API 自备以下几样：

- **插件发现驱动**：取得插件定义（例：Deno 用 import map、无 node_modules；浏览器打包成静态插件表），
  连同各实例的配置与禁用标记整批交给 `app.pluginAll([{ definition, config?, instanceId?, disabled? }, …])`。
  整批登记只重算一次，依赖方排在它 required 服务的全部提供者之后激活。`@aalis/plugin-hooks` 与
  `@aalis/plugin-contributions` 放进同一批。
- **配置文档**：core 只持运行态（各实例的配置、禁用态、服务偏好），文档的读写与落盘由宿主负责
  （例：浏览器配置走 fetch / IndexedDB）。交给 core 的配置原样生效，schema 默认值要由宿主先深合并进去
  （`withPluginConfigSync` 即此政策）；不能顶层浅合并，否则只写了半块的嵌套组会把默认值整块顶掉。
  文档里的服务偏好经根绑定的 `services.prefer` 应用，放在登记插件之前。schema 里 `secret: true` 的字段存在哪由宿主定：
  Node 宿主存进 `secrets.yaml`、文档里只留引用，交给 core 之前解析回原值；不做这一层的宿主把值以明文留在文档里，
  插件读取的方式不变。
- **重启策略**：实现 `RestartStrategy`，经 `AppOptions.restartStrategy` 注入（例：浏览器里「重启」改为重建实例）；
  不注入时 `app.restart()` 抛错。

三项宿主服务都经根绑定 `app.bind({ provide })` 登记：

- `hostPaths`（`@aalis/api-host-paths`）：家目录与安装集的绝对路径。`@aalis/plugin-storage-local` 与
  `@aalis/plugin-package-manager` 以 required 声明它，不提供时两者停在 pending；WebUI 以 `optional` 声明，
  缺席时市场与系统组件接口返回 503，也发现不到前端。
- `hostConfig`（`@aalis/api-host-config`）：要让管理类插件读写配置文档时提供。
- `pluginSource`（`@aalis/api-plugin-source`）：能在运行中重新发现插件时提供。

`hostPaths` 与 `hostConfig` 都要在登记任何插件之前就位，顺序为先提供 `hostPaths`，再 `installHostConfig`。
后两项不提供时，以 `optional` 声明它们的插件自行降级：市场视同没有新插件，WebUI 读写配置文档与扫描插件的接口返回 503。

在此之上再写一个等价的 `startXxx`。**core 与各插件契约不变**——这正是把 runtime 单独成包的目的。

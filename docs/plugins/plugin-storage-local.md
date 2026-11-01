# plugin-storage-local — 存储服务本地实现

**包名**: `@aalis/plugin-storage-local`  
**源码**: `packages/plugin-storage-local/src/index.ts`

## 概述

`@aalis/api-storage` 契约的本地文件系统实现，提供 `storage` 服务：只登记一个提供者，各根在它内部按 URI 的根名路由，全部根就绪之后才登记，依赖方激活时每个根都在；根名不认识时抛「未知存储根：x（已注册根：…）」。它给若干本机目录起稳定的名字（插件自己的数据在按数据目录布局派生的内部根里，文件工具用的根在 `roots` 数组里声明，缺省只有 workspace），让上层用 URI 表示文件而不写宿主机绝对路径；在每条 API 内对 `..` 穿越做规范化与校验；写入、删除、重命名、移动、建目录和下载都会记一行 info 日志，作为统一审计点；不管经哪个根，都不能读写宿主的密钥文件、不能改写主配置（见「宿主控制文件」）；`writeFile` 在快照之前先判目标类型，目标是目录就直接报「不能覆盖目录」——既然写目录本就必然失败，就不能让它先在 checkpoint 里留下一条「新建文件」记录，否则回滚会把整棵目录删掉；写入先写临时文件再 rename，覆写沿用原文件的权限位，凭据（`secret`）一律 0600，权限位在建临时文件时就给上；`list` / `stat` / `readFile` 只记 debug，同一操作对同一 URI 在 1 秒内只记一次。它不是沙箱：无法阻止 shell、run_python 等工具启动的子进程在拿到 cwd 之后访问 OS 用户可访问的任何文件，这种隔离只能靠 OS 用户权限、容器或 OS 级沙箱。`browsable` 只是给文件浏览器类 UI 的 hint，WebUI 没有文件浏览页，不读它；这些根供 agent 与工具按 URI 寻址。需要访问 workspace 之外的目录时，在 `roots` 里加一条路径限定到目标目录的具名根；加 `{ name: 'host', path: '/' }` 则可通过 `host:/` 访问宿主机任何位置（未显式设置 `writable` / `deletable` 时仅可读），注册时会输出 WARN 日志。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-storage-local',
  subsystem: 'storage',
  provides: [storage],
  uses: {
    provide,
    services,
    logger,
    lifecycle,
    config,
    paths: hostPaths,
    doctor: optional(doctor),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

配置项由 `configSchema` 声明（`packages/plugin-storage-local/src/index.ts`）。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `roots` | array | `[{"name":"workspace","label":"Workspace","kind":"workspace","browsable":true,"readable":true,"writable":true,"deletable":true}]` | 存储根目录：文件工具与 agent 寻址用的根（缺省只有 workspace）；插件自己的数据在内置根里（data、pluginData、tmp、cache、logs、personas、skills、workflows），这里同名的项会被跳过。直接编辑这个数组：删除不要的、修改 path、加自定义根、加 host:/ 直通根。browsable 是给文件浏览器类界面的 hint（WebUI 没有文件浏览页，不读它）。 |

`path` 可写绝对路径，也可写相对路径；相对路径按数据目录（`host-paths` 的 `data`）解析，与进程的 cwd 无关；留空时指向默认工作区目录（`host-paths` 的 `workspace`）。插件以 required 声明 `host-paths`，宿主不提供时停在 pending。

## 内部根

插件另注册一组内部根，存放各插件自己的数据。它们按 `host-paths` 给出的数据目录布局派生，不能配置（都是 `browsable: false`）：

| 根 | 路径 | kind | 权限 | 用途 |
|---|---|---|---|---|
| `data` | `<数据目录>/state` | `data` | 可读、可写、可删 | 插件状态：数据库、向量库、会话、附件、checkpoint、WebUI 凭据等。根名保留为 `data`，历史消息里的附件句柄（如 `data:/images/…`）照常可用 |
| `pluginData` | `<数据目录>/state/plugins` | `pluginData` | 可读、可写、可删 | 各插件的私有数据目录 |
| `tmp` | `<数据目录>/tmp` | `tmp` | 可读、可写、可删 | 临时文件 |
| `cache` | `<数据目录>/cache` | `cache` | 可读、可写、可删 | 缓存 |
| `logs` | `<数据目录>/logs` | `logs` | 只读 | runtime 的文件日志 `latest.log` 所在（WebUI 与 CLI 的日志页经宿主的 `host-logs` 读日志，不经这个根） |
| `self` | `<数据目录>/self` | `self` | 可读、可写、可删 | 存下来就会自己生效、owner 与她都会读改的内容。各插件经 api-storage 的 `content` 在 `self:/<目录名>/` 里分开，如 [plugin-persona](./plugin-persona.md) 的 `self:/persona/`、[plugin-skills](./plugin-skills.md) 的 `self:/skills/` |

- 内部根排在用户根之后（`listRoots()` 按这个次序列出）；激活时建好目录，建目录失败只告警并跳过，不影响其它根。
- `roots` 里与内部根同名的项被跳过并记 warn，内部根优先；被跳过的项不会建目录。旧版配置文件里落盘的 `data`、`tmp`、`pluginData`、`logs` 条目（旧默认值）同样按同名跳过并告警，可以直接删掉；原来自建了与内部根同名的根（如 `self`）的，要改名。
- 用户根可以一个都没有（例如 `roots` 里的条目全被跳过）：此时只记一条 warn，内部根照常注册，只是文件工具没有工作根。
- `pluginData` 在 `data` 的目录之下，`data:/plugins/…` 与 `pluginData:/…` 指向同一批文件。
- `self` 是一个根，不按插件分开：`self:/persona/../skills/x` 仍在 `self` 根里，一个插件的路径拼接失误能碰到另一个插件的内容，这层隔离是有意放弃的。
- kind 为 `data`、`pluginData`、`tmp`、`cache`、`logs`、`self` 的根不被 checkpoint 记录（见 [plugin-checkpoint](./plugin-checkpoint.md)）。

默认的 `workspace` 根不写 `path`，指向默认工作区目录（`host-paths` 的 `workspace`，`<数据目录>/workspace`），不另写一份位置；`roots` 显式为 `[]` 时同样注册它。写了 `path` 的以用户的为准：把 `workspace` 根的 `path` 改到别处，文件工具的 `workspace:/` 就跟着走；触及（[plugin-reach](./plugin-reach.md)）的默认主目录照旧是 `host-paths` 的 `workspace`，不跟这里的配置走。显式数组中的根必须有 `name`；`path`、权限位或数组元素形态无效时整组配置拒绝激活，不会把坏条目删光后误用默认根。

## 宿主控制文件

数据目录的 `secrets.yaml` 与 `aalis.config.yaml`（`host-paths` 的 `secrets` 与 `config`）由宿主（runtime）负责读写。插件在执行点兜底，不管目标经哪个根进来：

- `secrets.yaml` 读写都拒绝；`aalis.config.yaml` 拒绝写入，允许读取。写入、删除、改名、移动与建目录都按写处理。
- 按 (dev, ino) 比对目标与控制文件，硬链接与符号链接都挡得住；目标还不存在时按真实路径比对。
- 删除、移动、改名一个目录，或经 `resolveLocalPath` 以写、删的方式交出一个目录的本地路径时，子树里含受保护的文件也拒绝，按目录身份 (dev, ino) 判断（macOS 的 firmlink、bind mount 给同一目录的别名也认得出）。以读的方式交出目录（例如命令的工作目录）不查子树：拿到目录的工具本来就能按绝对路径读任何文件，挡它们靠沙箱。
- 控制文件不存在时，往它的位置写、在它下面建目录都拒绝；比较不分大小写（macOS 与 Windows 的卷默认不分）。
- `list` 与 `stat` 不受影响。

内部根与默认的 `workspace` 都不含这两个文件；用户根的路径覆盖数据目录（如 `host:/` 直通根）时，这道检查拦住经该根的访问。它只约束经 storage 的访问，子进程拿到本地路径之后的访问不在此列（见概述）。

## 相关

- 存储服务契约：[api/api-storage.md](../api/api-storage.md)
- 存储服务说明：[services/storage.md](../services/storage.md)
- 存储 URI 文法：[concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)

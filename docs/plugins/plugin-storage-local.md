# plugin-storage-local — 存储网关本地实现

**包名**: `@aalis/plugin-storage-local`  
**源码**: `packages/plugin-storage-local/src/index.ts`

## 概述

`@aalis/api-storage` 契约的本地文件系统实现，提供 `storage` 服务。它给若干本机目录起稳定的名字（在 `roots` 数组里声明，默认含 workspace / data / tmp / pluginData / logs），让上层用 URI 表示文件而不写宿主机绝对路径；在每条 API 内对 `..` 穿越做规范化与校验；写入、删除、重命名、移动、建目录和下载都会记一行 info 日志，作为统一审计点；`writeFile` 在快照之前先判目标类型，目标是目录就直接报「不能覆盖目录」——既然写目录本就必然失败，就不能让它先在 checkpoint 里留下一条「新建文件」记录，否则回滚会把整棵目录删掉；`list` / `stat` / `readFile` 只记 debug，同一操作对同一 URI 在 1 秒内只记一次。它不是沙箱：无法阻止 shell、run_python 等工具启动的子进程在拿到 cwd 之后访问 OS 用户可访问的任何文件，这种隔离只能靠 OS 用户权限、容器或 OS 级沙箱。`browsable` 只是给文件浏览器类 UI 的 hint，当前 WebUI 文件页只显示其 `fileRoot` 配置指向的那一个根，其它根仅供 agent 与工具按 URI 寻址。需要访问内置根之外的目录时，在 `roots` 里加一条路径限定到目标目录的具名根；加 `{ name: 'host', path: '/' }` 则可通过 `host:/` 访问宿主机任何位置（未显式设置 `writable` / `deletable` 时仅可读），注册时会输出 WARN 日志。

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
    doctor: optional(doctor),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

配置项由 `configSchema` 声明（`packages/plugin-storage-local/src/index.ts`）。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `roots` | array | `[{"name":"workspace","path":"workspace","label":"Workspace","kind":"workspace","browsable":true,"readable":true,"writable":true,"deletable":true},{"name":"data","path":"data","label":"Data","kind":"data","browsable":false,"readable":true,"writable":true,"deletable":true},{"name":"tmp","path":"workspace/.tmp","label":"临时文件","kind":"tmp","browsable":false,"readable":true,"writable":true,"deletable":true},{"name":"pluginData","path":"data/plugins","label":"插件数据","kind":"pluginData","browsable":false,"readable":true,"writable":true,"deletable":true},{"name":"logs","path":"data","label":"日志","kind":"logs","browsable":false,"readable":true,"writable":false,"deletable":false}]` | 存储根目录：所有可用根都在这里声明（包括 workspace/data/tmp 等内置根）。直接编辑这个数组：删除不要的、修改 path、加自定义根、加 host:/ 直通根。browsable 是给 WebUI 等浏览器类组件的 hint（注意：当前 WebUI 文件页固定显示 fileRoot 配置指向的那一个根，其它根仅作为工具/agent 寻址使用）。 |

## 内部根

插件另注册不受 `roots` 影响的内部根，不在文件页出现：

| 根 | 路径 | kind | 权限 | 用途 |
|---|---|---|---|---|
| `paper` | `<cwd>/data/stage/paper` | `paper` | 可读、可写、可删，`browsable: false` | 白纸枢纽（[plugin-paper](./plugin-paper.md)）存放远端任务的成品与工程包 |
| `public` | `<cwd>/data/stage/public` | `public` | 可读、可写、可删，`browsable: false` | [作品审核](./plugin-publish-review.md)存放审核通过的公开文件，作品站据此部署 |

- 内部根在用户根之后注册，不会成为 storage 的默认根；激活时建好目录，建目录失败只告警并跳过，不影响用户根。
- `roots` 里与内部根同名的项被跳过并记 warn，内部根优先；被跳过的项不会建目录。原来自建了名为 `paper` 或 `public` 的根的，要改名。
- 「没有任何可用根」的报错只看用户根：`roots` 全部无效时照样报错。
- `kind: 'paper'` 的根不被 checkpoint 记账：枢纽在任意会话的回合进行中写入成品，记进那一轮的话，回滚会删掉无关的成品（见 [plugin-checkpoint](./plugin-checkpoint.md)）。
- `data` 根映射整个 `data/` 时，`data:/stage/paper/…` 与 `paper:/…` 指向同一批文件。
- `kind: 'public'` 同样不参与 checkpoint：审核、部署与撤下不属于正在运行的聊天回合，回滚会话不能把公开作品恢复或删除。`public:` 是内部存储根，不意味着文件自动通过 HTTP 公开；只有审核服务认可的文件才会交给作品站。

`roots` 缺省或显式为 `[]` 时使用内置五根。显式数组中的根必须有 `name` 和 `path`；路径、权限位或数组元素形态无效时整组配置拒绝激活，不会把坏条目删光后误用内置根。

## 相关

- 存储服务契约：[api/api-storage.md](../api/api-storage.md)
- 存储服务说明：[services/storage.md](../services/storage.md)
- 存储 URI 文法：[concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)
- WebUI 服务端（文件页 `fileRoot`）：[plugin-webui-server.md](./plugin-webui-server.md)

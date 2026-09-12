# plugin-storage-local — 存储网关本地实现

**包名**: `@aalis/plugin-storage-local`  
**源码**: `packages/plugin-storage-local/src/index.ts`

## 概述

`@aalis/api-storage` 契约的本地文件系统实现，提供 `storage` 服务。它给若干本机目录起稳定的名字（在 `roots` 数组里声明，默认含 workspace / data / tmp / pluginData / logs），让上层用 URI 表示文件而不写宿主机绝对路径；在每条 API 内对 `..` 穿越做规范化与校验；写入、删除、重命名、移动、建目录和下载都会记日志（删除为 warn，其余为 info），作为统一审计点；`list` / `stat` / `readFile` 只记 debug，同一操作对同一 URI 在 1 秒内只记一次。它不是沙箱：无法阻止 shell、run_python 等工具启动的子进程在拿到 cwd 之后访问 OS 用户可访问的任何文件，这种隔离只能靠 OS 用户权限、容器或 OS 级沙箱。`browsable` 只是给文件浏览器类 UI 的 hint，当前 WebUI 文件页只显示其 `fileRoot` 配置指向的那一个根，其它根仅供 agent 与工具按 URI 寻址。需要访问内置根之外的目录时，在 `roots` 里加一条路径限定到目标目录的具名根；加 `{ name: 'host', path: '/' }` 则可通过 `host:/` 访问宿主机任何位置（未显式设置 `writable` / `deletable` 时仅可读），注册时会输出 WARN 日志。

## 插件声明

```typescript
meta.name = '@aalis/plugin-storage-local'
meta.provides = ['storage']
meta.inject = { optional: ['doctor'] }
meta.subsystem = 'storage'
```

## 配置

配置项由 `configSchema` 声明（`packages/plugin-storage-local/src/index.ts`）。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `roots` | array | `[{"name":"workspace","path":"workspace","label":"Workspace","kind":"workspace","browsable":true,"readable":true,"writable":true,"deletable":true},{"name":"data","path":"data","label":"Data","kind":"data","browsable":false,"readable":true,"writable":true,"deletable":true},{"name":"tmp","path":"workspace/.tmp","label":"临时文件","kind":"tmp","browsable":false,"readable":true,"writable":true,"deletable":true},{"name":"pluginData","path":"data/plugins","label":"插件数据","kind":"pluginData","browsable":false,"readable":true,"writable":true,"deletable":true},{"name":"logs","path":"data","label":"日志","kind":"logs","browsable":false,"readable":true,"writable":false,"deletable":false}]` | 存储根目录：所有可用根都在这里声明（包括 workspace/data/tmp 等内置根）。直接编辑这个数组：删除不要的、修改 path、加自定义根、加 host:/ 直通根。browsable 是给 WebUI 等浏览器类组件的 hint（注意：当前 WebUI 文件页固定显示 fileRoot 配置指向的那一个根，其它根仅作为工具/agent 寻址使用）。 |

## 相关

- 存储服务契约：[api/api-storage.md](../api/api-storage.md)
- 存储服务说明：[services/storage.md](../services/storage.md)
- 存储 URI 文法：[concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)
- WebUI 服务端（文件页 `fileRoot`）：[plugin-webui-server.md](./plugin-webui-server.md)

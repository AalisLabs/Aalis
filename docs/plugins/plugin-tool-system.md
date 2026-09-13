# plugin-tool-system — 系统工具集

**包名**: `@aalis/plugin-tool-system`  
**源码**: `packages/plugin-tool-system/src/index.ts`

## 概述

机器交互基础工具集，提供 Shell 命令、文件操作、系统信息和 HTTP 请求等工具。四类工具各有独立的配置开关，但对外只暴露 `system` 一个工具分组（见下文[工具组](#工具组)）。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-system'
meta.inject = { required: ['tools'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `workingDirectory` | string | `'workspace:/'` | 初始工作目录：进程启动时的初始 cwd（unix 心智模型）。agent 可用 cd 工具在会话内切换，不会写回本配置。shell/code-runner 仍使用各自独立的 workingDirectory 配置，不受 cd 影响。 |
| `shell` | object | — | Shell 工具 |
| `shell.enabled` | boolean | `true` | 启用 Shell 工具 |
| `shell.defaultTimeout` | number | `30000` | 默认超时 (ms) |
| `shell.maxTimeout` | number | `300000` | 最大超时 (ms) |
| `shell.maxOutputSize` | number | `65536` | 最大输出字节 |
| `file` | object | — | 文件工具 |
| `file.enabled` | boolean | `true` | 启用文件工具 |
| `file.maxReadSize` | number | `1048576` | 最大读取字节 |
| `file.maxSearchBytes` | number | `1048576` | 单次搜索最大扫描字节 |
| `file.maxWriteSize` | number | `10485760` | 最大写入字节 |
| `file.allowedRoots` | multiselect | `["workspace","tmp"]` | 允许访问的存储根：默认仅 agent 工作区（workspace/tmp），不含 data 等系统根（防裸读 data:/users.json 等）。设为 * 放开全部 readable 根；也可显式列出根名。写入/删除仍受各根自身权限限制。 |
| `system` | object | — | 系统工具 |
| `system.enabled` | boolean | `true` | 启用系统工具 |
| `http` | object | — | HTTP 工具 |
| `http.enabled` | boolean | `true` | 启用 HTTP 工具 |
| `http.defaultTimeout` | number | `30000` | 默认超时 (ms) |
| `http.maxResponseSize` | number | `1048576` | 最大响应字节 |

## 路径与 cwd 心智模型

所有 `file_*` 工具的 `path` 参数遵循 unix shell 风格：

- **完整 storage URI**（`aalis:/packages/core`、`workspace:/notes/a.md`）→ 直接定位
- **相对路径**（`packages/core`、`./a.ts`、`../plugin-tools`）→ 基于当前 session 的 cwd 解析
- **宿主机绝对路径**（`/Users/...`、`C:\...`、`C:/...`）→ 一律拒绝（Windows 盘符文法与单字母根名冲突，工具路径输入侧一律按盘符处理，单字母根名在工具里不可达）

`cwd` 工具返回当前目录 + 所有可用 storage 根的清单（含读/写/删权限），调用一次即可看清"我在哪、能去哪"。`cd` 工具切换当前 session 的 cwd（仅内存，进程重启回到 `workingDirectory` 配置值，不写配置文件）。

`shell` 与 `code-runner` 仍使用各自独立的 `workingDirectory` 配置，**不**受 `cd` 影响 —— 子进程模型决定了它们只能在文件系统型根下执行。


## 工具组

本插件只向 tools 服务注册**一个**工具分组 `system`（标签「系统工具」），下面四类工具全部落在这一个分组里：

| 源码模块 | 工具 | 配置开关 |
|---|---|---|
| shell | Shell 命令执行 | `shell.enabled` |
| file | 文件读写操作 | `file.enabled` |
| system | 系统信息查询 | `system.enabled` |
| http | HTTP 请求 | `http.enabled` |

> **shell / file / system / http 是配置开关与源码模块名，不是分组名。** 平台档的 `enabledToolGroups` 只认 `system` 这一个组名：写 `['file']` 匹配不到本插件的任何工具（静默、无告警；无分组的通用工具不受分组闸影响，仍照常可见）；写 `['system']` 则一次放开 exec、file_write、http_request 等全部工具。要按类收窄，用上表的配置开关关掉整类，而不是在平台档里按模块名列。

## file 工具：exclude/include 与 file_search 行为

`file_search` 与 `file_tree` 接受可选参数 `exclude`、`include`（数组，glob 字符串）。

### 默认排除（DEFAULT_EXCLUDE_PATTERNS）

```
node_modules/**   dist/**    build/**    .git/**    .pnpm/**
.next/**          .turbo/**  .yarn/**    coverage/**
__pycache__/**    *.pyc      .DS_Store   Thumbs.db
```

调用方传入 `exclude` 时**替换**默认列表（不追加）；`exclude: []` 关闭全部默认，全量搜索。
`include` 仅做**正向白名单**（命中即保留），未指定时所有未被 exclude 的条目都纳入。

### Glob 语义

- `*` 匹配单段内任意字符（不跨 `/`）
- `**/` / `/**` 匹配**零或多层**目录（修复了之前"至少一层"导致 `node_modules/**` 不命中根目录下 `node_modules/foo.js` 的 bug）
- `?` 单字符（不跨 `/`）

### 目录级早跳

`collectFiles()` 在递归进入目录前先用 exclude 测试目录路径，命中则整棵子树短路。
对 `node_modules` / `.git` 等大目录是 O(命中即跳)，不会逐文件遍历再丢弃。

### 截断提示

`file_search` 结果默认上限 200 条；超出时 `advice` 字段会建议缩小搜索范围或追加 `include`。

### 目录模式的续搜协议

目录搜索的预算（`maxResults` / `maxSearchBytes`）跨文件累加，耗尽即 `truncated: true`。此时结果里一定带 `nextStartFile`（相对所搜目录的文件路径）与 `nextStartLine`：下一次调用传**同一个 `path`** 加这两个值，并把本次的 `pattern` / `isRegex` / `ignoreCase` / `exclude` / `include` **原样重传**，就从断点原地接着扫，不重复也不遗漏。这几个参数任一不同则断点失效：文件集或匹配规则一变，断点指向的位置就不再是同一个（漏传 `isRegex` 会静默按字面量少命中，漏传 `exclude` 则断点文件可能已被排除，直接报 `startFile` 未找到）。

- `startFile`：从这个文件开始扫，遍历序（目录优先、字典序、与 `collectFiles` 同源）在它之前的文件整体跳过；只在目录搜索生效，不在该目录下时直接报错而非静默从头重扫
- `startLine`：文件模式下是文件内起始行；目录模式下须与 `startFile` 同传，表示在 `startFile` 内的起始行，其余文件一律整篇扫

断点的取法：

| 耗尽方式 | `nextStartFile` | `nextStartLine` |
| --- | --- | --- |
| `maxResults` 用完 | 停下的那个文件 | 最后一条命中行 + 1 |
| `maxSearchBytes` 用完 | 停下的那个文件 | 最后扫描行 + 1 |

断点只有这两种：预算一耗尽，停在哪个文件就从那个文件续，不存在「从下一个文件第 1 行开始」的情形。预算正好在某文件最后一行用完时，`nextStartLine` 会越过该文件末尾：下次续搜只是多开一次空文件，命中集不受影响。

### 正则模式体检

`isRegex: true` 时模式先过体检再编译。体检**拦下已知的几类灾难性写法（嵌套量词、含量词的分支重复、无界量词堆叠），不是完备保证**——判据是语法形状而非真实回溯代价，放行的模式里仍可能有慢写法。被拒的几类：

- 嵌套量词：重复量词作用在「内部含无界量词或分支」的分组上（`(a+)+`、`((a+)a)+`，子分组的标记向父层传播）；内部全有界的嵌套（`(?:[0-9]{1,3}\.){3}[0-9]{1,3}`、`(\d{2}:){3}`）重复次数封顶为常数，照常放行
- 含量词的分支重复（`(a+|b)*`）；无内层量词的分支重复（`(?:foo|bar)+`）一并拒掉，分支是否重叠无法便宜判定
- 无界量词（`+` `*` `{n,}`）多于 5 个（`a+a+a+a+a+a+b`）；有上限的 `{n}` / `{n,m}` 不计入这一项
- 模式超过 500 字符、量词总数多于 20 个（`a?a?a?…x` 这类堆叠同样能爆）

V8 的正则回溯是同步执行的，超时与 abort 都打不断，`(a+)+$` 这类模式每多两个字符耗时翻数倍，足以把整个进程冻住——故取舍是被拒只需换个模式重试，冻死进程则不可恢复。字面量、字符类、单层量词、锚点、未加量词的分组与分支、`.*foo.*bar.*` / `^\s*//.*$` 这类常态写法照常放行。需要纯文本语义时传 `isRegex: false`，模式整体按**字面量**处理，不过体检。

## file 工具：改动类操作的串行闸

`file_edit` / `file_append` / `file_write` / `file_move` / `file_delete` 按 storage URI 排队执行。前三者是「读—改—写」，而 agent 同一轮的 tool call 并行发起：无闸时两次改同一文件会各读到同一份原文、后写者盖掉前写者，两边都回「成功」。闸只按 URI 串行，不同文件仍并行；`file_move` 按字典序依次取两端的键，避免交叉移动互等。

`file_append` 读原文失败时不再当成空文件：**只有「文件不存在」（`ENOENT`）才走创建**，读原文的其余错误（不可读的根、瞬时 IO 错）一律原样返回错误——否则整篇写回会把原文静默截断成只剩追加的部分。宁可这次追加失败，也不拿空串当原文。

## 共享 runtime 工具

storage URI 规范化（`toStorageUri` / `resolveAgainstCwd` / `parseStorageUri`）已**抽取到** [@aalis/api-storage](../api/api-storage.md)，SSRF 私网判定（`isPrivateHost` / `isPrivateAddress`）已**抽取到** [@aalis/util-network-guard](../utils/network-guard.md)；本包内部以及 `plugin-tool-browser` / `plugin-tool-code-runner` 都直接复用，不再各写一份。`api-tools` 现为纯契约包，原 `utils` 已删除。

## 指令

- `/tools` — 列出本插件四类工具（shell / file / system / http）各自的启用情况

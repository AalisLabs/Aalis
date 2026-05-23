# Node 内置模块使用建议

> 适用版本：当前 `dev` 分支
> 配套接口：`@aalis/plugin-storage-api` / `@aalis/plugin-process-api`
> 配套 lint：`biome.json` 中 `style/noRestrictedImports` 规则 + 显式 overrides 例外清单

## 0. 这份文档的定位

**这份文档是建议而非铁律。** 除了下面 § 1 明确写出的「`@aalis/core` 不 import 任何 `node:*`」这一条之外，其它所有规则都是：

- **lint 默认值**：通过 `biome.json` 把一些 `node:*` 加入 `noRestrictedImports`，目的是当你不小心绕过 storage / process 网关时**给一个有解释的报错**，而不是默默引入难以审计的耦合。
- **社区约定**：让生态里的插件优先用同一套抽象（storage / process / fetch），方便用户切换后端、方便重构、方便给某些场景做沙箱。

如果你写的是**第三方插件**，并且：

- 评估后认为某个 `node:*` 用法在你的场景里是合理的；
- 接受随之而来的「与 Aalis 抽象层耦合度变低」的代价；

完全可以在你自己插件的 `biome.json` 或 lint 配置里 `noRestrictedImports: off`。**没有人会强制阻止**——这是一个建议清单，不是审批流程。社区收录时会评审是否合理，但你的插件能不能跑起来不取决于它。

下面所有「建议 / 推荐 / 优先」字样都按这个语境理解。

## 1. 总原则

`@aalis/core` 是**环境无关**的内存运行时（不 import 任何 `node:*`、不读 `process.env`、不调 `process.cwd()`），所有副作用都被推到插件层。**这一条是核心架构红线**，让 core 理论上可以在 Workers / Deno / 浏览器 host 等环境里运行。

基于这条红线，对插件层我们给出以下默认建议：

- **业务插件**（agent、memory、tools、persona、scheduler、websearch、image-recognition、…）建议**优先**通过以下网关访问宿主能力，而不是直接 import `node:*`：
  - 文件系统 → `@aalis/plugin-storage-api`（`createStorageGateway(ctx)`，沙箱根 workspace/data/tmp/pluginData/logs/aalis）
  - 子进程 / 外部文件 / 临时目录 → `@aalis/plugin-process-api`（`createProcessGateway(ctx)`，能力含 `spawn`/`execFile`/`makeTempDir`/`readExternalFile`/`external-fs`）
  - 出站网络 → `useNetwork()` / fetch
  - 入站网络 → 服务端类插件（webui-server / mcp-server）
  - 系统信息（CPU/内存/用户名）→ `plugin-tool-system` 的 `system_info` 工具

  这样做的好处是：用户切换 storage 后端（local / S3 / 内存）时插件不用改，重构时影响面可控，集成测试用 mock 网关更顺手。

- **基础设施插件**（提供上述网关的实现，或本身就是宿主服务，例如 HTTP 入站）通常需要直接使用对应的 `node:*`，这是它们的本职。每个例外在 `biome.json` 的 `overrides` 例外清单中显式列出，**并在本文件登记原因**——如果有新例外，建议同时更新两处，方便审阅者理解。

- **几乎总是可以直接用**的 `node:*` 模块（详见 § 1.5 边界说明）：
  - `node:buffer` —— Web 标准 `Uint8Array` 不能完全覆盖二进制 API（`Buffer.from(x,'base64')` / `Buffer.concat` / `Buffer.toString('hex')` 一行搞定），且 `StorageService.writeFile` 签名 `string | Buffer` 等 API 直接要求 Buffer。
  - `node:path` —— 纯函数路径运算（join/resolve/dirname/extname/posix），无 I/O，无 Web 等价替代。
  - `node:url` —— `fileURLToPath` / `pathToFileURL` 推荐使用；`URL` 本身建议用全局 `URL`，避免 `import { URL } from 'node:url'` 这种冗余写法。

- **建议优先用 Web 标准替代**的 `node:*` 模块：
  - `node:crypto` —— 推荐用全局 Web Crypto（`crypto.subtle.digest` / `crypto.randomUUID` / `crypto.getRandomValues`）。Web Crypto 已能覆盖绝大多数场景；只有遇到 Web Crypto 确实没有的高级需求（如 X.509、传统 hash 算法）才需要回到 `node:crypto`，那种情况欢迎走 § 4 流程加例外。

## 1.5 Buffer / URL / Crypto 边界

实践经验：

- **Buffer**：新代码默认用 `Uint8Array` 比较省心；以下场景显式 `import { Buffer } from 'node:buffer'` 更顺手：
  - 调用 `StorageService.writeFile` 等强制要求 Buffer 签名的 API；
  - 需要 `base64` / `hex` 编解码一行流（`Buffer.from(s,'base64')` / `.toString('base64')`）；
  - 需要 `Buffer.concat([...])` 拼接多个二进制片段。
- **URL**：`new URL(...)` 直接用全局；只有把 `file://` URI 换成本地路径或反向操作时才 `import { fileURLToPath, pathToFileURL } from 'node:url'`。
- **Crypto**：`crypto.subtle.digest('SHA-256', bytes)` 返回 `ArrayBuffer`；hex 化要手动 `Array.from(new Uint8Array(ab)).map(b=>b.toString(16).padStart(2,'0')).join('')`。`crypto.randomUUID()` 与 `crypto.getRandomValues()` 直接调全局即可。

## 2. 模块 → 提供者映射

| node 模块 | 业务插件建议做法 | 当前直接持有者 | 持有原因 |
|---|---|---|---|
| `node:fs` / `node:fs/promises` | 走 `@aalis/plugin-storage-api` | `plugin-storage-local` | StorageService 的当前实现 |
|  |  | `plugin-process-local` | `readExternalFile()`：用于 OneBot 直推的 `/tmp/...` 等不在任何 storage 根内的绝对路径 |
|  |  | `plugin-webui-server` | `existsSync` 探测前端 dist 目录（位于工作区外、由 webui-client 提供） |
|  |  | `create-aalis-plugin` | 脚手架 CLI，物理生成新插件目录 |
|  |  | `plugin-tool-browser` | 探测 puppeteer 包内 `cli.js` 与 Chrome 是否已下载（包资产管理） |
| `node:child_process` | 走 `@aalis/plugin-process-api`（`spawn`/`execFile`） | `plugin-process-local` | ProcessService 的当前实现 |
| `node:http` / `node:https` | 出站建议用 fetch | `plugin-webui-server` | HTTP **入站**服务 + WebSocket 升级 |
|  |  | `plugin-mcp-server` | HTTP/SSE **入站**端点 |
| `node:os` | 走 `system_info` 工具聚合返回 | `plugin-tool-system/src/tools/system.ts` | 该工具的本意就是暴露系统信息 |
| `node:crypto` | 推荐 Web Crypto（`crypto.subtle.digest` / `crypto.randomUUID` / `crypto.getRandomValues`） | — | 当前无例外 |
| `node:buffer` / `node:path` | 直接使用 | 全部 | 纯函数 / Web 标准不覆盖，无 I/O |
| `node:url` | `fileURLToPath` / `pathToFileURL` 推荐使用；`URL` 用全局 | 全部 | 仅用作路径互转时引入 |

## 3. 直接持有 node:* 的插件清单（白名单）

每行格式：`插件 — 引入的 node:* — 用途`。biome.json `overrides[1].includes` 与此清单保持一致即可让 lint 通过。

### 基础设施（网关实现）

- **`plugin-storage-local`** — `node:fs`（`createReadStream` / `watch`）+ `node:fs/promises`（CRUD）
  本地文件系统后端，实现 `StorageService` 接口。其它插件想落盘走 `createStorageGateway(ctx)` 通常更省事，不必绕过它。

- **`plugin-process-local`** — `node:child_process`（`spawn`）+ `node:fs/promises`（`readFile`）
  `ProcessService` 的当前实现：负责 `spawn`/`execFile`/`makeTempDir`/`readExternalFile`。`readExternalFile` 用于 OneBot 等推流场景，源端给的是 OS 直读路径（如 `/tmp/xxx.jpg`），不属于任何 storage 根，所以故意绕过 storage 沙箱直接 `fs.readFile`；调用方在 ProcessCapability 中声明 `'external-fs'` 即可使用。

### 入站网络服务

- **`plugin-webui-server`** — `node:http`（`createServer`）+ `node:fs`（`existsSync`）
  Express + ws 实现的 WebUI 后台。`existsSync` 用于探测 `webui-client` 的 dist 目录是否存在；服务启动后浏览器拉取的用户文件都走 `storage.createReadStream`，不直接 `fs.readFile` 工作区内容。`autoOpen` 打开浏览器走 `ProcessService.spawn`。

- **`plugin-mcp-server`** — `node:http`（`createServer`）
  HTTP/SSE 形式的 MCP 服务端，对外暴露工具/资源/提示词。

### 系统信息工具

- **`plugin-tool-system/src/tools/system.ts`** — `node:os`
  实现 `system_info` 工具（hostname/cpu/uptime/loadavg/memory/userInfo）。整个 plugin-tool-system 包只有这一个文件被列入例外；同包其它工具（shell/file 等）走 ProcessService / StorageService。

### 脚手架

- **`create-aalis-plugin`** — `node:fs`（`existsSync`）+ `node:fs/promises`（`mkdir`/`writeFile`）
  `npm create aalis-plugin` 的 CLI，在工作区外生成新插件目录，无法、也不应通过 storage 网关。

### 浏览器自动化

- **`plugin-tool-browser/src/index.ts`** — `node:fs`（`existsSync`）+ `node:path` + `node:url`（`fileURLToPath`）
  动态 `import('puppeteer')` 后需要对 puppeteer 包做包内文件探测（找到内置 `cli.js`、检测 Chrome 是否已下载），属于 puppeteer 包的本地资产管理需求，storage 网关覆盖不到。**Chrome 安装本身**（原先的 `execFileSync`）已迁移到 `ProcessService.execFile`。

> 历史遗留迁移已完成：`plugin-file-reader` 的 sha256 hashId 改 Web Crypto；`plugin-asr-openai` / `plugin-ollama` 的 `file://` 读取改走 `ProcessService.readExternalFile`；`plugin-tool-browser` 的 Chrome 安装改走 `ProcessService.execFile`。新代码建议不要再加入直接动态 import `node:fs|crypto|child_process`——如果有需要，欢迎按 § 4 流程申报新的例外。

## 4. 增加新例外的流程（仅当你想合入社区 / 让 lint 通过）

1. **先评估**：能否扩展 `StorageService` / `ProcessService` 接口（如新增 `external-fs` 之类的能力）使你的需求落到既有网关里？能就走网关——通常对集成测试和后端切换更友好。
2. 若确实需要新插件直接持有某个 `node:*`：
   - 在本文件 § 3 增加条目，写清「引入的模块 + 必要理由」。
   - 在 `biome.json` `overrides[1].includes` 增加对应路径。
   - 必要时同步更新 `overrides[0]` 中该模块的提示文字（保持错误信息与白名单一致）。
3. CI 通过 = 三处自洽。审阅者据此判断是否真的「必要」。

第三方插件如果不打算合入主仓库，**完全可以在自己的 lint 配置里把 `noRestrictedImports` 关掉**，跳过这套流程。

## 5. 与其它文档的关系

- 架构总览：`docs/architecture.md` § "环境无关 core"。
- StorageService 接口与沙箱说明：`packages/plugin-storage-api/src/index.ts` 顶部 JSDoc。
- ProcessService 接口与 capability：`packages/plugin-process-api/src/index.ts`。
- 插件作者指南：`docs/plugin-author-guide.md` —— 新作者首先建议看的就是本文件。

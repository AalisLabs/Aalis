# Node 内置模块使用范围与各插件职责

> 适用版本：当前 `dev` 分支
> 强制方式：`biome.json` 中 `style/noRestrictedImports` 规则 + 显式 overrides 例外清单
> 配套接口：`@aalis/plugin-storage-api` / `@aalis/plugin-process-api`

## 1. 总原则

`@aalis/core` 是**环境无关**的内存运行时（不 import 任何 `node:*`、不读 `process.env`、不调 `process.cwd()`），所有副作用都被推到插件层。这意味着：

- **业务插件**（agent、memory、tools、persona、scheduler、websearch、image-recognition、…）**不得**直接 import `node:fs` / `node:fs/promises` / `node:child_process` / `node:os` / `node:http` / `node:https`。
- **业务插件**通过以下网关访问宿主能力：
  - 文件系统 → `@aalis/plugin-storage-api`（`createStorageGateway(ctx)`，沙箱根 workspace/data/tmp/pluginData/logs/aalis）
  - 子进程 / 外部文件 / 临时目录 → `@aalis/plugin-process-api`（`createProcessGateway(ctx)`，能力含 `spawn`/`execFile`/`makeTempDir`/`readExternalFile`/`external-fs`）
  - 出站网络 → `useNetwork()` / fetch
  - 入站网络 → 仅服务端类插件（webui-server/mcp-server）持有
  - 系统信息（CPU/内存/用户名）→ `plugin-tool-system` 的 `system_info` 工具

- **基础设施插件**（提供上述网关的实现，或本身就是宿主服务，例如 HTTP 入站）才允许直接使用对应的 `node:*`。每个例外都在 `biome.json` 的 `overrides` 例外清单中显式列出，**并在本文件登记原因**——增加新例外必须同时更新两处。

- **永远允许**的 `node:*` 模块（详见 § 1.5 边界说明）：
  - `node:buffer` —— Web 标准 `Uint8Array` 不能完全覆盖二进制 API（`Buffer.from(x,'base64')` / `Buffer.concat` / `Buffer.toString('hex')` 一行搞定），且 `StorageService.writeFile` 签名 `string | Buffer` 等内部 API 直接要求 Buffer。允许全局使用。
  - `node:path` —— 纯函数路径运算（join/resolve/dirname/extname/posix），无 I/O，无 Web 等价替代。
  - `node:url` —— **仅允许** `fileURLToPath` / `pathToFileURL`。`URL` 本身请使用全局 `URL`，不要 `import { URL } from 'node:url'`。

- **永远不允许**的 `node:*` 模块（即使在基础设施插件中也优先用 Web 标准）：
  - `node:crypto` —— 全部用全局 Web Crypto（`crypto.subtle.digest` / `crypto.randomUUID` / `crypto.getRandomValues`）。仅在确有 Web Crypto 无法覆盖的高级需求（如 X.509、传统 hash 算法等）才申报例外。

## 1.5 Buffer / URL / Crypto 边界

- **Buffer**：新代码默认使用 `Uint8Array`；只有以下场景才显式 `import { Buffer } from 'node:buffer'`：
  - 调用 `StorageService.writeFile` / 第三方库强制要求 Buffer 签名；
  - 需要 `base64` / `hex` 编解码一行流（`Buffer.from(s,'base64')` / `.toString('base64')`）；
  - 需要 `Buffer.concat([...])` 拼接多个二进制片段。
- **URL**：`new URL(...)` 直接用全局；只有把 `file://` URI 换成本地路径或反向操作时才 `import { fileURLToPath, pathToFileURL } from 'node:url'`。
- **Crypto**：`crypto.subtle.digest('SHA-256', bytes)` 返回 `ArrayBuffer`；hex 化需要手动 `Array.from(new Uint8Array(ab)).map(b=>b.toString(16).padStart(2,'0')).join('')`。`crypto.randomUUID()` 与 `crypto.getRandomValues()` 直接调全局。

## 2. 模块 → 提供者映射

| node 模块 | 业务插件正确做法 | 直接持有者（例外） | 例外原因 |
|---|---|---|---|
| `node:fs` / `node:fs/promises` | `@aalis/plugin-storage-api` | `plugin-storage-local` | StorageService 的唯一实现 |
|  |  | `plugin-process-local` | `readExternalFile()`：用于 OneBot 直推的 `/tmp/...` 等不在任何 storage 根内的绝对路径 |
|  |  | `plugin-webui-server` | `existsSync` 探测前端 dist 目录（位于工作区外、由 webui-client 提供） |
|  |  | `create-aalis-plugin` | 脚手架 CLI，物理生成新插件目录 |
|  |  | `plugin-tool-browser` | 探测 puppeteer 包内 `cli.js` 与 Chrome 是否已下载（包资产管理） |
| `node:child_process` | `@aalis/plugin-process-api`（`spawn`/`execFile`） | `plugin-process-local` | ProcessService 的唯一实现 |
| `node:http` / `node:https` | 不允许出站调用使用；出站请用 fetch | `plugin-webui-server` | HTTP **入站**服务 + WebSocket 升级 |
|  |  | `plugin-mcp-server` | HTTP/SSE **入站**端点 |
| `node:os` | `system_info` 工具（聚合返回） | `plugin-tool-system/src/tools/system.ts` | 该工具的本意就是暴露系统信息 |
| `node:crypto` | **不允许**；改 Web Crypto（`crypto.subtle.digest` / `crypto.randomUUID` / `crypto.getRandomValues`） | — | 无例外 |
| `node:buffer` / `node:path` | 直接使用 | 全部 | 纯函数 / Web 标准不覆盖，无 I/O |
| `node:url` | **仅** `fileURLToPath` / `pathToFileURL`；`URL` 用全局 | 全部 | 仅限路径互转 |

## 3. 直接持有 node:* 的插件清单（白名单）

每行格式：`插件 — 引入的 node:* — 用途`。biome.json `overrides[1].includes` 必须与此清单一致。

### 基础设施（网关实现）

- **`plugin-storage-local`** — `node:fs`（`createReadStream` / `watch`）+ `node:fs/promises`（CRUD）
  本地文件系统后端，实现 `StorageService` 接口。其它任何插件想要落盘必须通过 `createStorageGateway(ctx)` 走它，而不是绕过。

- **`plugin-process-local`** — `node:child_process`（`spawn`）+ `node:fs/promises`（`readFile`）
  唯一 `ProcessService` 实现：负责 `spawn`/`execFile`/`makeTempDir`/`readExternalFile`。`readExternalFile` 是为了 OneBot 等推流场景，源端给的是 OS 直读路径（如 `/tmp/xxx.jpg`），不属于任何 storage 根，因此故意绕过 storage 沙箱直接 `fs.readFile`；调用方需要在 ProcessCapability 中声明 `'external-fs'`。

### 入站网络服务

- **`plugin-webui-server`** — `node:http`（`createServer`）+ `node:fs`（`existsSync`）
  Express + ws 实现的 WebUI 后台。`existsSync` 仅用于探测 `webui-client` 提供的 dist 目录是否存在；服务启动后浏览器拉取的所有用户文件都已改为走 `storage.createReadStream`，不再直接 `fs.readFile` 工作区内容。`autoOpen` 打开浏览器已迁移到 `ProcessService.spawn`。

- **`plugin-mcp-server`** — `node:http`（`createServer`）
  HTTP/SSE 形式的 MCP 服务端，对外暴露工具/资源/提示词。

### 系统信息工具

- **`plugin-tool-system/src/tools/system.ts`** — `node:os`
  实现 `system_info` 工具（hostname/cpu/uptime/loadavg/memory/userInfo）。整个 plugin-tool-system 包**只有这一个文件**被列入例外；同包其它工具（shell/file 等）已迁移到 ProcessService / StorageService。

### 脚手架

- **`create-aalis-plugin`** — `node:fs`（`existsSync`）+ `node:fs/promises`（`mkdir`/`writeFile`）
  `npm create aalis-plugin` 的 CLI，在工作区外生成新插件目录，无法、也不应通过 storage 网关。

### 浏览器自动化

- **`plugin-tool-browser/src/index.ts`** — `node:fs`（`existsSync`）+ `node:path` + `node:url`（`fileURLToPath`）
  动态 `import('puppeteer')` 后需要对 puppeteer 包做包内文件探测（找到内置 `cli.js`、检测 Chrome 是否已下载），这是 puppeteer 包的本地资产管理需求，无 storage 网关能覆盖。**Chrome 安装本身**（原先的 `execFileSync`）已迁移到 `ProcessService.execFile`。

> ✅ 历史遗留迁移已完成：`plugin-file-reader` 的 sha256 hashId 改 Web Crypto；`plugin-asr-openai` / `plugin-ollama` 的 `file://` 读取改走 `ProcessService.readExternalFile`；`plugin-tool-browser` 的 Chrome 安装改走 `ProcessService.execFile`。新代码不要再加入直接动态 import `node:fs|crypto|child_process`。

## 4. 增加新例外的流程

1. **先评估**：能否扩展 `StorageService` / `ProcessService` 接口（如新增 `external-fs` 之类的能力）使你的需求落到既有网关里？能就走网关。
2. 若确实需要新插件直接持有某个 `node:*`：
   - 在本文件 § 3 增加条目，写清"引入的模块 + 必要理由"。
   - 在 `biome.json` `overrides[1].includes` 增加对应路径。
   - 必要时同步更新 `overrides[0]` 中该模块的提示文字（保持错误信息与白名单一致）。
3. CI 通过 = 三处自洽。审阅者据此判断是否真的"必要"。

## 5. 与其它文档的关系

- 架构总览：`docs/architecture.md` § "环境无关 core"。
- StorageService 接口与沙箱说明：`packages/plugin-storage-api/src/index.ts` 顶部 JSDoc。
- ProcessService 接口与 capability：`packages/plugin-process-api/src/index.ts`。
- 插件作者指南：`docs/plugin-author-guide.md` —— **新作者首先要看的就是本文件**。

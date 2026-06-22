# process 服务

## 1. 定位

把所有 `node:child_process` / `node:os` / `node:fs` 直读用法收口到一个能力插件后面，让业务插件无需直接 import 这些 Node 内置模块，即可**执行子进程、创建临时目录、读取 OS 外部文件**。

- 服务注册名：`'process'`（`ctx.getService<ProcessService>('process')`）。
- 契约包：`@aalis/plugin-process-api`（`packages/plugin-process-api/src/index.ts`）。
- 默认实现：`@aalis/plugin-process-local`（`packages/plugin-process-local/src/index.ts`）。

> 注意：**process 不是沙箱**。`spawn` 出来的子进程拥有宿主进程的完整 OS 权限（默认连承宿主全量 `process.env`），`readExternalFile` 可读任意 OS 路径。需要隔离的不可信代码执行请看 [code-sandbox 服务](./code-sandbox.md) 与第 6 节。

---

## 2. 契约

接口与类型全部由 `@aalis/plugin-process-api` 导出。真实签名（贴 file:line）：

### 2.1 `ProcessService`（`plugin-process-api/src/index.ts:76-101`）

```ts
interface ProcessService {
  // 同 child_process.spawn，但只接 (cmd, args, opts)，不接 shell 字符串
  spawn(cmd: string, args: readonly string[], opts?: SpawnOptions): SpawnHandle;          // :80
  // 同 execFile，返回 ExecResult；非零退出会 reject（err.result 挂 ExecResult）
  execFile(cmd: string, args: readonly string[], opts?: SpawnOptions): Promise<ExecResult>; // :85
  // 在 storage 的 tmp:/ 根下创建本地临时目录，拿到本地绝对路径，用完调 cleanup()
  makeTempDir(prefix: string): Promise<TempDirHandle>;                                     // :90
  // 读 OS 任意本地路径（绕过 storage root 沙箱）——仅限「外部推来的路径」场景
  readExternalFile(path: string): Promise<Uint8Array>;                                     // :100
}
```

容器类型映射在同文件 `declare module '@aalis/core' { interface ServiceTypeMap { process: ProcessService } }`（`:103-107`），因此 `ctx.getService('process')` 已带类型推断。

### 2.2 `SpawnOptions`（`:14-36`）

```ts
interface SpawnOptions {
  cwd?: string;                                  // 工作目录（本地绝对路径）
  env?: Record<string, string | undefined>;      // 注入/覆盖环境变量
  timeout?: number;                              // 毫秒；到时 SIGKILL 子进程（:17）
  input?: string | Uint8Array;                   // 写入 stdin 的内容（:19）
  detached?: boolean;                            // 与父进程解耦；须配 stdio:'ignore' 且手动 unref()（:25）
  stdio?: 'pipe' | 'ignore' | 'inherit';         // 默认 'pipe'（:30）
  maxBuffer?: number;                            // wait() 累计缓冲（stdout+stderr 合计）字节上限（:35）
}
```

`maxBuffer` 缺省由实现给安全默认（本地实现 = 10MB，见第 7 节）。

### 2.3 `ExecResult`（`:38-49`）

```ts
interface ExecResult {
  code: number | null;          // 退出码；被信号杀死时为 null
  signal: NodeJS.Signals | null; // 终止信号（如超时的 SIGKILL）
  stdout: string;
  stderr: string;
  truncated?: boolean;          // 输出超 maxBuffer 被截断（区别于 timeout 的 SIGKILL）（:48）
}
```

### 2.4 `SpawnHandle`（`:51-64`）

```ts
interface SpawnHandle {
  pid: number | undefined;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  wait(): Promise<ExecResult>;             // 等子进程结束（:57）
  kill(signal?: NodeJS.Signals): boolean;  // 杀子进程（:59）
  unref(): void;                           // 仅 detached 模式有效，否则 no-op（:63）
}
```

### 2.5 `TempDirHandle`（`:67-74`）

```ts
interface TempDirHandle {
  path: string;                  // 本地绝对路径，可直接传给子进程
  uri: string;                   // 对应 storage URI（tmp:/...），可被 storage 读写
  cleanup(): Promise<void>;      // 递归删除该目录
}
```

### 2.6 导出的工具函数

- `createProcessGateway(ctx): ProcessService`（`:112-126`）——**消费方标准入口**。返回一个网关：无实例时抛错、有实例时每次方法调用都重新 `ctx.getService('process')` 后转发（懒取，见第 5 节）。
- `makeTempDirViaStorage(storage, prefix): Promise<TempDirHandle>`（`:129-148`）——**给 provider 用的辅助**。基于一个支持 `resolveLocalPath` 的 `StorageService` 实现 `makeTempDir` 的默认骨架；prefix 会被脱敏（`[^A-Za-z0-9_-]` → `_`，截 32 字符），目录落在 `tmp:/<prefix>-<ts>-<rand>`。storage 不支持 `resolveLocalPath` 时抛错。

---

## 3. 谁提供 / 谁消费

### 提供方（参考实现）

`@aalis/plugin-process-local`（`packages/plugin-process-local/src/index.ts`）——唯一的内置实现 `LocalProcessService`（`:19-127`），用 `node:child_process` / `node:fs/promises` 落地，`apply()` 里 `ctx.provide('process', service)`（`:133`）。

### 典型消费点（均经 `createProcessGateway`）

| 包 | 用途 | file:line |
| --- | --- | --- |
| `plugin-tool-system` | `exec` / `exec_background` shell 工具组 | `src/tools/shell.ts`（`index.ts:139` 取网关） |
| `plugin-tool-code-runner` | 代码执行（fail-closed 到 code-sandbox） | `src/index.ts:188` |
| `plugin-code-sandbox-os` | 在 process.spawn 外再裹 bwrap/seatbelt 沙箱 | `src/index.ts:73` |
| `plugin-media` | ffmpeg 抽帧/转音轨 + makeTempDir | `src/ffmpeg.ts`（`index.ts:314` 注入 runtime） |
| `plugin-office` | PDF 工具（可选依赖，见第 5 节） | `src/index.ts:112` |
| `plugin-adapter-onebot` | `readExternalFile` 读 daemon 推来的附件路径 | `src/attachment-cache.ts:117` |
| `plugin-asr-whisper-cpp` / `plugin-asr-openai` | 调本地 whisper / 转码 | `src/index.ts:108` / `:96` |
| `plugin-ollama` / `plugin-package-manager` / `plugin-tool-browser` / `plugin-webui-server` | 拉起本地进程 / 装包 / 起浏览器 | 各 `src/index.ts` |

---

## 4. 写一个 provider

### 必须实现 vs 可选

接口四个方法**都必须实现**，没有可选方法。但常见做法是复用本地实现的骨架：

- `makeTempDir` 可直接转发 `makeTempDirViaStorage(storage, prefix)`（`process-local` 即如此，`index.ts:119-121`）——你只需注入一个支持 `resolveLocalPath` 的 storage。
- `execFile` 通常用 `spawn(...).wait()` 包一层（本地实现 `index.ts:106-117`：非零退出 reject 并把 `ExecResult` 挂在 `err.result`）。

替换默认实现（如远程执行 / 容器内执行）时用 `priority` 抬高；不替换、只想并存请用 `entryId`。

### 注册（priority / entryId / label）

`ctx.provide(name, instance, options?)`，options 见 [服务模型 §2.1](../concepts/service-model.md)：

```ts
import type { Context, PluginModule } from '@aalis/core';
import { ServicePriority } from '@aalis/core';
import type { ProcessService, ExecResult, SpawnHandle, SpawnOptions, TempDirHandle } from '@aalis/plugin-process-api';
import { makeTempDirViaStorage } from '@aalis/plugin-process-api';
import { createStorageGateway, type StorageService } from '@aalis/plugin-storage-api';

export const name = '@aalis/plugin-process-remote';
export const provides = ['process'];          // 双源之一：导出常量
export const inject = ['storage'];             // makeTempDir 依赖 storage

class RemoteProcessService implements ProcessService {
  constructor(private readonly storage: StorageService) {}
  spawn(cmd: string, args: readonly string[], opts?: SpawnOptions): SpawnHandle { /* ... */ }
  async execFile(cmd: string, args: readonly string[], opts?: SpawnOptions): Promise<ExecResult> { /* ... */ }
  async makeTempDir(prefix: string): Promise<TempDirHandle> {
    return makeTempDirViaStorage(this.storage, prefix);
  }
  async readExternalFile(path: string): Promise<Uint8Array> { /* ... */ }
}

export async function apply(ctx: Context): Promise<void> {
  const storage = createStorageGateway(ctx);
  ctx.provide('process', new RemoteProcessService(storage), {
    priority: ServicePriority.Override,        // 想盖过 process-local（Backend=0）时抬高；同存则省略
    label: 'Process / remote',                 // WebUI/CLI Services 视图展示
    // entryId: `${ctx.id}/remote`,            // 只在「一个插件拆多条 entry」时用，前缀必须是 ctx.id
  });
}

const plugin: PluginModule = { name, apply };
export default plugin;
```

### provides / inject 双源必须与 package.json 同步

清单元数据是**双源**的（见 [清单元数据](../concepts/manifest-metadata.md)）。除了源码里导出 `provides` / `inject`，`package.json` 的 `aalis.service` 也要写——参考 `plugin-process-local/package.json`：

```jsonc
{
  "keywords": ["aalis", "aalis-plugin"],
  "aalis": {
    "service": {
      "provides": ["process"]
      // "inject": ["storage"]   // 若 makeTempDir 走 storage，应一并声明
    }
  }
}
```

> 契约包 `plugin-process-api` 自身**不提供任何运行时服务**，它的 `package.json` 用的是 `"aalis": { "types": true }` + `keywords: ["aalis-api"]`，标记为「纯类型/契约包」。别把 `aalis.service` 写到契约包上。

---

## 5. 标准消费姿势

### 懒取（必须）

永远用 `createProcessGateway(ctx)`，**不要缓存它转发到的实例**——网关内部每次方法调用都重新 `ctx.getService('process')`（`plugin-process-api/src/index.ts:113-119`），这样 provider 被换人/下线（provider bounce）后下一次调用自动命中新胜者。详见 [懒服务访问](../concepts/lazy-service-access.md)。

```ts
import { createProcessGateway } from '@aalis/plugin-process-api';

export async function apply(ctx: Context): Promise<void> {
  const proc = createProcessGateway(ctx);   // 持有网关 OK；别把 proc.spawn 解构出来长期持有

  const result = await proc.execFile('git', ['rev-parse', 'HEAD'], { timeout: 5000 });
  ctx.logger.info(result.stdout.trim());
}
```

### 临时目录：try/finally cleanup

`makeTempDir` 拿到的目录**必须在 finally 里 cleanup**，否则 `tmp:/` 下泄漏。参考 `plugin-media/src/ffmpeg.ts:108-140`：

```ts
const tmp = await proc.makeTempDir('media-frames');
try {
  await proc.execFile('ffmpeg', ['-i', filePath, /* ... */ `${tmp.path}/frame_%04d.png`], { timeout: 60000 });
  const buf = await storage.readFile(`${tmp.uri}/frame_0001.png`); // 也可经 storage URI 读回
} finally {
  await tmp.cleanup();
}
```

### 服务缺失 / 可选依赖

- **硬依赖**：声明 `inject = ['process']`，框架在 process 就绪前不会 `apply` 你的插件；网关在缺失时也会抛 `未找到 process 服务...`（`plugin-process-api/src/index.ts:115-117`）。
- **可选依赖**：先 `ctx.hasService('process')` 探测再决定。参考 `plugin-office/src/index.ts:112`：`const proc = ctx.hasService('process') ? createProcessGateway(ctx) : undefined;`——没有 process 时 PDF 工具优雅降级。

### 错误边界

- `execFile` 非零退出会 **reject**，错误对象上挂 `result: ExecResult`（`plugin-process-local/src/index.ts:109-115`）——需要部分输出时从 `err.result.stderr` 取。
- `spawn().wait()` **不会**因非零退出 reject，只在子进程 `'error'`（如可执行文件不存在）时 reject；超时是正常 resolve（`signal` 为 `SIGKILL`/`SIGTERM`），不抛错。`plugin-tool-system` 的 `exec` 据此判断 `timedOut`（`shell.ts:158-173`）。

---

## 6. 能力 / 风险 → 影响

process 是框架里**权限最高的能力**之一（任意子进程 = 完整宿主权限）。约束分两层：

### Provider 侧

- **maxBuffer 边读边计数**：本地实现在 `wait()` 里边读边累计、超限即停止累积并标 `truncated`，**不杀进程**（后台 dev server/`--watch` 本应长跑，杀掉会误伤）——见 `plugin-process-local/src/index.ts:62-101`。自写 provider 也应有上限，**禁止**无限 `stdout += chunk` 再在 `Buffer.concat` 前累积（OOM 向量，见第 7 节）。
- **stdin error 必须挂监听**：`child.stdin.on('error', () => {})`——否则 EPIPE 这类异步错误无监听器会 `uncaughtException` 崩整个宿主进程（`index.ts:31-32`）。

### Consumer 侧（鉴权 / 确认）

process 本身**没有内核级鉴权门**——风险控制落在**调用它的工具**上。把 process 暴露给 LLM 的工具，要在工具层按 [鉴权模型](../concepts/security-model.md) / [authority](../core/authority.md) 设门：

- 任意 shell 命令是最强的 confused-deputy 向量。`plugin-tool-system` 的 `exec` / `exec_background` / `process_kill` 都设 `visibility: 'restricted'` + `confirm: 'session'`——**连 owner 也要本会话确认一次**（`shell.ts:139-141`、`:376-377`）。你的工具若直通 `spawn`，应比照此设级别 + 确认。
- shell 工具用 `safeEnv()` 只透传白名单环境变量（PATH/LANG/TERM 等），不暴露宿主全量 env（`shell.ts:84-91`）。注意这是工具自己做的——**`SpawnOptions.env` 不传时本地实现默认 `{ ...process.env, ...opts.env }` 继承全量宿主 env**（`plugin-process-local/src/index.ts:26`），敏感场景请显式传白名单 env。

### 不是沙箱

`readExternalFile` 显式**绕过 storage root 沙箱**读任意 OS 路径——契约注释（`plugin-process-api/src/index.ts:91-98`）限定它只用于「外部推来的本地路径」场景（如 OneBot daemon/NapCat 容器挂载的 `/tmp` 附件，`adapter-onebot/src/attachment-cache.ts:14-17`、`:116-118`）。它**不是** storage 的替代品：受沙箱约束的「在声明 root 内读写」请走 [storage 服务](./storage.md)。

需要在隔离环境跑不可信代码：用 [code-sandbox 服务](./code-sandbox.md)。`plugin-code-sandbox-os` 正是把 process.spawn 再裹一层 bwrap/seatbelt 启动器（`src/index.ts:60-68`），且后端不可用时 fail-closed。

### detached fire-and-forget

启动「打开浏览器」这类不需要等待的进程：`detached: true` + `stdio: 'ignore'` + `.unref()` 三件套缺一不可（`webui-server/src/auth.ts:180-195`），否则父进程会被吊住或无法独立退出。

---

## 7. 边界与坑（审计标注）

1. **`maxOutputSize` 是事后截断，不是流式限额（消费侧坑）。** 工具层常见的 `maxOutputSize` 只在拿到完整字符串后 `truncateOutput`（`plugin-tool-system/src/tools/shell.ts:67-71`），**真正的内存上限是 provider 的 `maxBuffer`**（本地默认 10MB，`plugin-process-local/src/index.ts:17`）。历史上 `exec` 自起无上限 `stdout += chunk` 累加器，在「超限只停累积不杀进程」改动之后会无界增长 → OOM；现已改为直接用 `wait()` 内部带 `maxBuffer` 上限的 `result.stdout/stderr`（`shell.ts:155-157`）。**自写工具切勿在 process 之上再叠一个无上限累加器**；`exec_background` 这类需要持续读流的，要像 `shell.ts:229-241` 那样自己滚动裁剪缓冲区。

2. **`readExternalFile` = confused-deputy + 无大小上限。** 它 `fs.readFile` 任意路径（`plugin-process-local/src/index.ts:123-126`），daemon 给什么路径就读什么、一次性全量进内存、且**不校验路径来源**。这是「daemon-trusted」的信任面——只在「确实是外部可信组件推来的路径」时用，不要把用户/LLM 可控字符串直接喂进去（路径遍历读取宿主任意文件）。下载的体积上限要由调用方自己加（参考 onebot 的 `readBodyCapped`，但那只覆盖 http，`readExternalFile` 路径无此保护）。

3. **`timeout` 走 SIGKILL，无优雅期。** 超时直接 `child.kill('SIGKILL')`（`index.ts:40-48`），子进程没有清理机会。需要 graceful 关停的长进程，自己拿 `handle.kill('SIGTERM')` 管理（`shell.ts` 的 `process_kill` 即如此）。

4. **`spawn` 不接 shell 字符串。** 只接 `(cmd, args[])`，要 shell 特性须显式 `spawn('/bin/sh', ['-c', cmd])`（`shell.ts:96-98`、`:149`）——这是有意为之，避免隐式 shell 注入面，但也意味着 provider/consumer 都要自己负责 shell 语义。

---

## 8. 交叉链接

- [服务模型](../concepts/service-model.md) —— DI 按名寻址、priority/preference/注册顺序、entryId 约定。
- [懒服务访问](../concepts/lazy-service-access.md) —— 为什么 `createProcessGateway` 每次重取、provider bounce。
- [清单元数据](../concepts/manifest-metadata.md) —— `provides`/`inject` 与 `package.json aalis.service` 双源。
- [存储 URI 文法](../concepts/storage-uri-grammar.md) —— `tmp:/` 根、`resolveLocalPath`（makeTempDir 的底座）。
- [安全模型](../concepts/security-model.md) / [authority](../core/authority.md) —— 给暴露 process 的工具设级别 + 确认。
- [storage 服务](./storage.md) —— 受沙箱约束的「在 root 内读写」（对照 `readExternalFile` 的直通）。
- [code-sandbox 服务](./code-sandbox.md) —— 隔离执行不可信代码（process 不是沙箱）。
- [tools](../core/tools.md) / [context](../core/context.md) —— 工具注册的 visibility/confirm、`ctx.provide`/`hasService`/`getService`。

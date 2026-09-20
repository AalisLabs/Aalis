# process 服务

## 1. 定位

把所有 `node:child_process` / `node:os` / `node:fs` 直读用法收口到一个能力插件后面，让业务插件无需直接 import 这些 Node 内置模块，即可**执行子进程、创建临时目录、读取 OS 外部文件**。

- 服务注册名：描述符 `processService`（`name: 'process'`），绑定接口是 `ServiceRef<ProcessService>`。
- 契约包：`@aalis/api-process`（`packages/api-process/src/index.ts`）。
- 默认实现：`@aalis/plugin-process-local`（`packages/plugin-process-local/src/index.ts`）。

> 注意：**process 不是沙箱**。`spawn` 产生的子进程拥有宿主进程的完整 OS 权限（默认继承宿主全量 `process.env`），`readExternalFile` 可读任意 OS 路径。需要隔离的不可信代码执行请看 [code-sandbox 服务](./code-sandbox.md) 与第 6 节。

> 路径来自外部时请传 `maxBytes`。典型场景是 OneBot daemon 推来的附件路径——不传上限就意味着把对方指定的任意大小文件整份读进堆。`readExternalFile` 在给了 `maxBytes` 时会先 `stat` 再决定读不读。

---

## 2. 契约

### 2.1 `ProcessService`

```ts
interface ProcessService {
  spawn(cmd: string, args: readonly string[], opts?: SpawnOptions): SpawnHandle;
  execFile(cmd: string, args: readonly string[], opts?: SpawnOptions): Promise<ExecResult>;
  makeTempDir(prefix: string): Promise<TempDirHandle>;
  readExternalFile(path: string, maxBytes?: number): Promise<Uint8Array>;
}
```

### 2.2 `SpawnOptions`

```ts
interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
  input?: string | Uint8Array;
  detached?: boolean;
  stdio?: 'pipe' | 'ignore' | 'inherit';
  maxBuffer?: number;
}
```

本地实现对 `env` 的语义是**叠加**（`{ ...process.env, ...opts.env }`）而非替换——传白名单不构成隔离。`maxBuffer` 缺省由实现给安全默认（本地实现 = 10MB）。

### 2.3 句柄

```ts
interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

interface SpawnHandle {
  pid: number | undefined;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  wait(): Promise<ExecResult>;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
}

interface TempDirHandle {
  path: string;
  uri: string;
  cleanup(): Promise<void>;
}
```

### 2.4 导出的工具函数

- `createProcessGateway(ref: ServiceRef<ProcessService>): ProcessService` ——**消费方标准入口**。无实例时抛错；每次方法调用读 `ref.current` 后转发。
- `makeTempDirViaStorage(storage, prefix): Promise<TempDirHandle>` ——**供 provider 使用的辅助**。基于一个支持 `resolveLocalPath` 的 `StorageService`。

---

## 3. 谁提供 / 谁消费

### 提供方

`@aalis/plugin-process-local`——`provide(processService, service)`。

### 典型消费点（均经 `createProcessGateway`）

`plugin-tool-system`、`plugin-tool-code-runner`、`plugin-code-sandbox-os`、`plugin-media`、`plugin-office`、`plugin-adapter-onebot`、`plugin-asr-*`、`plugin-llm-ollama`、`plugin-package-manager`、`plugin-tool-browser`、`plugin-webui-server`。

---

## 4. 写一个 provider

接口四个方法**都必须实现**。`makeTempDir` 可转发 `makeTempDirViaStorage`。替换默认实现时用 `priority` 抬高。

```ts
import { makeTempDirViaStorage, processService, type ExecResult, type ProcessService, type SpawnHandle, type SpawnOptions, type TempDirHandle } from '@aalis/api-process';
import { createStorageGateway, storage } from '@aalis/api-storage';
import { definePlugin, provide } from '@aalis/core';

class RemoteProcessService implements ProcessService {
  constructor(private readonly files: ReturnType<typeof createStorageGateway>) {}
  spawn(_cmd: string, _args: readonly string[], _opts?: SpawnOptions): SpawnHandle {
    throw new Error('未实现');
  }
  execFile(_cmd: string, _args: readonly string[], _opts?: SpawnOptions): Promise<ExecResult> {
    throw new Error('未实现');
  }
  makeTempDir(prefix: string): Promise<TempDirHandle> {
    return makeTempDirViaStorage(this.files, prefix);
  }
  readExternalFile(_path: string, _maxBytes?: number): Promise<Uint8Array> {
    throw new Error('未实现');
  }
}

export default definePlugin({
  name: '@aalis/plugin-process-remote',
  provides: [processService],
  uses: { provide, storage },
  apply({ provide, storage }) {
    provide(processService, new RemoteProcessService(createStorageGateway(storage)), {
      priority: 50,
      label: 'Process / remote',
    });
  },
});
```

---

## 5. 标准消费方式

始终使用 `createProcessGateway(process)`。网关内部每次方法调用都重新读 `ref.current`。可以持有网关；不要把 `process.current` 或某个 `SpawnHandle` 之外的服务实例缓存进字段。

```ts
import { createProcessGateway, processService } from '@aalis/api-process';
import { definePlugin, logger } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-process',
  uses: { process: processService, logger },
  apply({ process, logger }) {
    const proc = createProcessGateway(process);
    void proc.execFile('git', ['rev-parse', 'HEAD'], { timeout: 5000 }).then(result => {
      logger.info(result.stdout.trim());
    });
  },
});
```

### 临时目录：try/finally cleanup

`makeTempDir` 拿到的目录**必须在 finally 里 cleanup**。

### 服务缺失 / 可选依赖

- **硬依赖**：`uses: { process: processService }`；网关在缺失时抛 `未找到 process 服务...`。
- **可选依赖**：`optional(processService)`，先判 `process.current !== undefined` 再构造网关。

### 错误边界

- `execFile` 非零退出会 **reject**，错误对象上挂 `result: ExecResult`。
- `spawn().wait()` **不会**因非零退出 reject，只在子进程 `'error'` 时 reject；超时是正常 resolve。

---

## 6. 能力 / 风险 → 影响

process 是框架里**权限最高的能力**之一。约束分两层：

### Provider 侧

- **maxBuffer 边读边计数**：超限即停止累积并标 `truncated`，**不杀进程**。
- **stdin error 必须挂监听**：否则 EPIPE 会 `uncaughtException` 崩整个宿主。

### Consumer 侧

process 本身**没有内核级鉴权门**——风险控制落在**调用它的工具**上。`plugin-tool-system` 的 `exec` / `exec_background` / `process_kill` 都设 `visibility: 'restricted'` + `confirm: 'session'`。shell 工具**继承宿主完整环境**。需要环境隔离的执行走 code-sandbox-os。

### 不是沙箱

`readExternalFile` 显式**绕过 storage root** 读任意 OS 路径——只用于「外部推来的本地路径」。受沙箱约束的读写请走 [storage 服务](./storage.md)。

### detached fire-and-forget

启动不需要等待的进程：`detached: true` + `stdio: 'ignore'` + `.unref()` 三者缺一不可。

本地实现在 POSIX 下**对所有子进程都设 `detached`**，目的是让子进程自成进程组组长，超时与 `kill()` 才能打到孙进程。

`App.stop()` 先冻结激活，再发 `app:stopping`（知会，不驱动 drain/close），再执行关停计划。本地实现把补杀挂在 `events.on('app:stopping', () => service.killAll())` 上——**不是** `lifecycle.onDispose`：bounce 本插件时，别的插件正在跑的子进程（ffmpeg 等）不该陪葬。未显式 `detached: true` 的进程组在登记表里，停机知会时对仍有成员的组补 `SIGKILL`，维持「Aalis 退出，工具子进程一起退出」；显式 `detached: true` 的 fire-and-forget 不登记。停机期 unload / disable 汇入计划后立即返回 true，register / bounce 返回 false。单独卸载本提供者没有交接保证（子进程仍只挂在被拆掉的那份实例上）。

---

## 7. 边界与注意事项（审计标注）

1. **工具层 `maxOutputSize` 是事后截断**。真正的内存上限是 provider 的 `maxBuffer`。自写工具切勿在 process 之上再叠一个无上限累加器。
2. **`readExternalFile` = confused-deputy**。不要把用户/LLM 可控字符串直接喂进去。给了 `maxBytes` 才先 stat。
3. **`timeout` 走 SIGKILL，无优雅期，打的是整个进程组。**
4. **`wait()` 在 `'exit'` 后只等一个短宽限（200ms）就返回。** 子进程退出后孙进程的输出会被丢弃。
5. **`spawn` 不接 shell 字符串。** 要 shell 特性须显式 `spawn('/bin/sh', ['-c', cmd])`。

---

## 8. 交叉链接

- [服务模型](../concepts/service-model.md)
- [懒服务访问](../concepts/lazy-service-access.md)
- [清单元数据](../concepts/manifest-metadata.md)
- [存储 URI 文法](../concepts/storage-uri-grammar.md)
- [安全模型](../concepts/security-model.md) / [authority](../plugins/plugin-authority.md)
- [storage 服务](./storage.md)
- [code-sandbox 服务](./code-sandbox.md)
- [tools](../plugins/plugin-tools.md) / [context](../core/context.md)

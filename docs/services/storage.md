# storage 服务

**一句话定位**：命名根（named root）+ storage URI（`<root>:/path`）的文件后端——把宿主机若干目录起稳定名字，对外提供 `read/write/delete/rename/list/stat` 等基于 URI 的文件操作，让上层不必硬编码绝对路径。

- **服务注册名**：`getService('storage')` / `getAllServices('storage')`（字符串键 `storage`）。
- **契约包**：`@aalis/plugin-storage-api`（`packages/plugin-storage-api/src/index.ts`）。
- **参考实现**：`@aalis/plugin-storage-local`（`packages/plugin-storage-local/src/index.ts`）。
- **它不是沙箱**：见 [§6](#6-能力风险--影响安全边界)。

> 先读懂这条 URI 文法再往下：[docs/concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)。本文聚焦「怎么写一个 storage provider / 怎么消费」。

---

## 1. 契约：`StorageService` 接口

定义在 `packages/plugin-storage-api/src/index.ts:87-112`。所有方法的 `uri` 参数都是 `<root>:/相对路径`。

```ts
export interface StorageService {
  listRoots(): StorageRootInfo[];                                       // :88 该 provider 声明的所有根
  list(uri: string): Promise<StorageListResult>;                        // :89
  stat(uri: string): Promise<StorageStat>;                              // :90
  readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer>; // :91 不传 encoding 返回 Buffer
  createReadStream(uri: string): Promise<StorageReadStreamResult>;      // :92 流式下载
  writeFile(uri: string, data: string | Buffer): Promise<void>;         // :93
  rename(uri: string, newName: string): Promise<string>;                // :94 仅改名（同目录），返回新 URI
  delete(uri: string): Promise<void>;                                   // :95
  resolveLocalPath?(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string>; // :102 可选
  watch?(uri: string, listener: StorageWatchListener): StorageUnwatch;  // :111 可选
}
```

### 关键类型

**`StorageRootInfo`**（`:7-22`）——根的「身份证 + 权限位」，是整套权限模型的载体：

```ts
export interface StorageRootInfo {
  name: string;        // 根 ID = URI scheme，如 workspace、data；正则 /^[a-zA-Z][a-zA-Z0-9_-]*$/
  label?: string;      // 展示名
  kind: StorageRootKind; // 'workspace'|'data'|'tmp'|'pluginData'|'logs'|string（语义标签，:5）
  browsable: boolean;  // 是否允许通用文件浏览 UI 展示（仅 hint，见 §7）
  readable: boolean;   // 默认是否允许读
  writable: boolean;   // 默认是否允许写
  deletable: boolean;  // 默认是否允许删除
}
```

**`StorageEntry`**（`:24-32`，list 的元素）与 **`StorageStat`**（`:34-43`，stat 返回）字段相近，都带 `uri`/`path`/`isDirectory`/`size`/`mtime`/`ext`；`StorageStat` 额外有 `birthtime`。

**`StorageReadStreamResult`**（`:51-54`）：`{ stream: Readable; stat: StorageStat }`。

**`StorageWatchEvent`**（`:60-66`）：`{ type: 'change'; uri: string; path: string }`——当前实现把创建/修改/删除统一上报为 `change`；`StorageWatchListener = (event) => void`（`:68`），`watch` 返回 `StorageUnwatch = () => void`（`:71`）取消监听。

### 能力声明常量（可选互操作用）

`StorageCapabilities`（`:127-134`）：`{ List:'list', Read:'read', Write:'write', Delete:'delete', LocalPath:'local-path', Watch:'watch' }`。这些**不是 DI 能力声明**——`storage` 已不走能力选择（0.5.0 移除）。它们只在 helper（`createStorageGateway` / `resolveStorageEntryForRoot`）里被解释为「按 root 的 `readable/writable/deletable` 权限位 + `resolveLocalPath`/`watch` 方法是否存在」来过滤（`rootSatisfies`，`:220-243`）。

---

## 2. 契约包导出的 helper（消费者复用，勿各自重抄）

`@aalis/plugin-storage-api` 不只是类型——它导出一组纯函数 helper（`packages/plugin-storage-api/src/index.ts`），是消费者的标准入口：

| 函数 | file:line | 用途 |
| --- | --- | --- |
| `createStorageGateway(ctx)` | `:317` | **消费者首选**：返回一个 `StorageService`，每次方法调用按 URI 自动路由到对应 root 的 entry。不注册进容器。 |
| `getStorageEntries(ctx)` | `:179` | 枚举所有 storage entry（`= ctx.getAllServices('storage')`）。 |
| `aggregateStorageRoots(ctx)` | `:184` | 聚合全部 entry 的 root 列表（带 `providerId`/`provider`）。 |
| `getStorageRootConflicts(ctx)` | `:195` | 同名 root 冲突诊断（doctor / 启动日志用）。 |
| `resolveStorageByPath(ctx, uri, caps?)` | `:259` | 按 URI 找到服务该 root 的 entry。 |
| `isStorageUri(s)` | `:279` | **权威文法判定**：`s` 是不是 `<root>:/path`。区分 `http/https/file` 与标准 `data:image/...;base64,`。全体消费者复用。 |
| `parseUriRoot(uri)` | `:286` | 取根名（`data:/x` → `data`）。 |
| `toStorageUri(input, fallbackRoot='data')` | `:301` | 把配置里的裸名/相对路径归一为 storage URI。 |

---

## 3. 谁提供 / 谁消费

### 提供者（参考实现）

`@aalis/plugin-storage-local`（`packages/plugin-storage-local/src/index.ts`）——把 `config.roots` 里声明的若干本机目录注册为命名根。内部用 `ScopedStorageService`（`:256`）：**每个 root 一个实例 + 一个容器 entry**（见 §4 entryId）。

### 典型消费点

| 消费者 | file:line | 用法 |
| --- | --- | --- |
| 文件工具组 | `packages/plugin-tool-system/src/index.ts:149` | `createStorageGateway(ctx)` 做 read/write/list（注册段把网关传给 `file.ts` 的 `storage` 配置字段） |
| shell 工具 | `packages/plugin-tool-system/src/index.ts:138` | `createStorageGateway(ctx)`；网关传给 `shell.ts` 后用 `resolveLocalPath(uri,'read')` 取 cwd 本地路径 |
| code-runner | `packages/plugin-tool-code-runner/src/index.ts:161-170` | 运行时探测 `resolveLocalPath`，解析子进程 cwd |
| skills | `packages/plugin-skills/src/index.ts:1164` | `storage.watch?.(skillsUri, …)` 监听技能目录增量同步 |
| file-reader | `packages/plugin-file-reader/src/index.ts:199` | `createStorageGateway(ctx)` |
| checkpoint | `packages/plugin-checkpoint/src/index.ts:113` | 同上（同时被 storage 反向调用做写前快照，见 §7） |
| memory / persona / scheduler / media / onebot / asr / authority / office… | （`grep createStorageGateway`） | 均经 `createStorageGateway(ctx)` 消费 |

`createStorageGateway` 是所有消费者的统一入口——含 plugin-tool-system 里的全部工具组：shell（`index.ts:138`）、file（`:149`）、system（`:160`）、http（`:166`）都经它取网关。`file.ts:28` / `shell.ts:22` 上的 `storage?: StorageService` 只是配置字段的类型标注；注册段实际传入的是该网关，没有任何消费者经 DI 拿到单 root 的 `StorageService` 句柄。

---

## 4. 写一个 provider

### 4.1 最小必须实现 vs 可选

| 必须 | 可选 |
| --- | --- |
| `listRoots` `list` `stat` `readFile` `createReadStream` `writeFile` `rename` `delete` | `resolveLocalPath`（无本地路径语义的远程/虚拟根可不实现）、`watch`（远程/虚拟根可不实现） |

不实现可选方法时，`createStorageGateway` 会在调用方收到明确报错（`:359-361`、`:366-368`：「存储根 X 不支持 local-path/watch」），不会静默。

### 4.2 注册：`ctx.provide` + per-root entryId

参考实现的注册段（`packages/plugin-storage-local/src/index.ts:682-692`）——**一个 root 一个 entry**：

```ts
for (const root of roots) {
  const scoped = new ScopedStorageService(root, logger, ctx);
  ctx.provide('storage', scoped, {
    entryId: `${ctx.id}/${root.name}`,      // 每个 root 独立 entryId，避免跨实例/跨根同名冲突
    label: root.label || `本地根 ${root.name}`,
  });
}
```

- **`entryId: ${ctx.id}/${root.name}`**：service-granularity 约定（per-entry provide）。同一插件可注册多个 storage entry，每个对应一个 root；`getAllServices('storage')` 会把它们全部枚举出来，gateway 据此按 URI 路由。
- **`label`**：会进入 `AggregatedStorageRoot.provider`（`:150`），用于冲突诊断展示。
- **`priority`**：本服务靠「URI → root 名」精确路由，不靠 DI 同名优胜，所以**通常不设 priority**。若你确实要覆盖内置某个同名 root（如自己实现 `data` 根），用 `ServicePriority`（Backend=0/Override=50/System=200，见 [docs/core/service.md](../core/service.md)）。同名 root 不会两个都生效——`createStorageGateway.listRoots` 按枚举顺序去重首个胜出（`:340-345`），冲突可由 `getStorageRootConflicts` 暴露。

### 4.3 双源 manifest 同步

`provides`/`inject` 必须同时写进 `package.json` 的 `aalis.service`。参考实现：

```jsonc
// packages/plugin-storage-local/package.json
"aalis": {
  "service": {
    "optional": ["doctor"],   // 对应 export const inject = { optional: ['doctor'] }
    "provides": ["storage"]   // 对应 export const provides = ['storage']
  }
}
```

源码侧（`packages/plugin-storage-local/src/index.ts:22-25`）：

```ts
export const provides = ['storage'];
export const inject = { optional: ['doctor'] };
```

两源不一致会被 manifest 校验拦下，详见 [docs/concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。

### 4.4 可编译的最小骨架

```ts
import type { Context } from '@aalis/core';
import type {
  StorageService, StorageRootInfo, StorageListResult, StorageStat, StorageReadStreamResult,
} from '@aalis/plugin-storage-api';

export const name = '@aalis/plugin-storage-mybackend';
export const provides = ['storage'];

class MyRoot implements StorageService {
  constructor(private readonly root: StorageRootInfo) {}
  listRoots() { return [this.root]; }
  async list(uri: string): Promise<StorageListResult> { /* … */ throw new Error('todo'); }
  async stat(uri: string): Promise<StorageStat> { /* … */ throw new Error('todo'); }
  async readFile(uri: string, enc?: BufferEncoding): Promise<string | Buffer> { /* … */ throw new Error('todo'); }
  async createReadStream(uri: string): Promise<StorageReadStreamResult> { /* … */ throw new Error('todo'); }
  async writeFile(uri: string, data: string | Buffer): Promise<void> { /* … */ }
  async rename(uri: string, newName: string): Promise<string> { /* … */ return uri; }
  async delete(uri: string): Promise<void> { /* … */ }
  // resolveLocalPath / watch 可选，按后端能力决定是否实现
}

export async function apply(ctx: Context): Promise<void> {
  const root: StorageRootInfo = {
    name: 'mybackend', label: 'My Backend', kind: 'external',
    browsable: false, readable: true, writable: true, deletable: false,
  };
  ctx.provide('storage', new MyRoot(root), { entryId: `${ctx.id}/${root.name}`, label: root.label });
}
```

> provider 内部务必自己做 `..` 穿越 / symlink 越界校验（参考实现 `isInside`+`realpath`，`:540-562`）——契约对 URI 只规定文法，不保证安全。

---

## 5. 标准消费姿势

### 5.1 lazy + gateway（推荐）

```ts
import { createStorageGateway } from '@aalis/plugin-storage-api';

export const inject = { required: ['storage'] };          // 双源，package.json 同步
export async function apply(ctx: Context) {
  const storage = createStorageGateway(ctx);              // 每个 apply 重新构造
  const buf = await storage.readFile('data:/persona.yaml');
}
```

- gateway 内部用 `ctx.getAllServices('storage')`，自身就是 lazy 的——每次方法调用现取 entry。
- **不要把单个 root 的 `StorageService` 实例缓存到模块作用域**：provider bounce / 重载会让旧实例失效。每次 `apply`（含被 bounce 后重跑）重新 `createStorageGateway(ctx)`。详见 [docs/concepts/lazy-service-access.md](../concepts/lazy-service-access.md)。

### 5.2 把 storage 设为 `required` 还是 `optional`

- 离不开文件（file-reader、skills、checkpoint）→ `required: ['storage']`（参考 `plugin-file-reader/src/index.ts:22-25`）。框架保证 `apply` 时 storage 已就绪。
- 锦上添花（如某 UI 仅在有 storage 时显示文件页）→ `optional`；消费时 `createStorageGateway` 仍可调用，但若没有任何 storage entry，`dispatch` 会抛「未知存储根」。

### 5.3 错误边界

`createStorageGateway` 的 `dispatch`（`:325-336`）在路由不到 root 时抛带「已注册根列表」的 Error。常见失败：

- **未知根 / 根没有所需权限**：`未知存储根: X（已注册根: …, 需能力 [write]）`。
- **可选方法缺失**：`存储根 X 不支持 local-path/watch（远程协议或纯虚拟根）`——调用 `resolveLocalPath`/`watch` 前可先判 `if (storage.resolveLocalPath)`（参考 shell 工具 `shell.ts:74`）。
- **权限位拒绝**：provider 内 `requirePermission` 抛 `存储根 X 不允许该操作 (writable)`（`plugin-storage-local/src/index.ts:534-538`）。
- **路径越界**：抛 `路径不合法`。

消费者应捕获并转成对 LLM/用户友好的提示，而不是把原始栈抛给模型。

---

## 6. 能力/风险 → 影响（安全边界）

### `resolveLocalPath` 不是沙箱 —— provider 与 consumer 都必须懂

契约注释写死了这条边界（`packages/plugin-storage-api/src/index.ts:73-85`、`:96-101`，参考实现 `:27-48`）：

- `resolveLocalPath` 把 URI 解析成宿主机**绝对路径**，交给 `run_python`/shell/code-runner 当 cwd 或起点用。
- 解析过程**只校验目标在声明根内**（lexical + realpath 双查，`:540-562`），**不约束子进程之后的访问范围**。子进程拿到路径后能访问当前 OS 用户可访问的任何文件。
- **真正的隔离靠 OS 用户权限 / 容器 / OS 沙箱**（bwrap、seatbelt），不是这一层。code-runner 据此运行时探测 `resolveLocalPath` 并自建沙箱策略（`plugin-tool-code-runner/src/runner.ts:73`）。
- 因此：consumer 不要把 `resolveLocalPath` 的返回值当成「越不出去的边界」；provider 也别暗示它是。

### 高危直通根

参考实现允许 `{ name:'host', path:'/' }` 这种直通根（`plugin-storage-local/src/index.ts:110-111`、`:658-663`）——agent 即可 `host:/绝对路径` 访问宿主机任意位置。注册时会打 WARN。provider 作者若开放此类根，须明确这是高危配置。

### 权限位即授权语义

root 的 `readable/writable/deletable`（`StorageRootInfo`）就是该根的访问策略：参考实现每次操作前 `requirePermission`（`:534-538`），gateway 路由时按位过滤（`rootSatisfies`，`:226-242`）。这与框架的 [authority 等级体系](../core/authority.md)是**两套**机制——storage 不读 session 等级，权限只看 root 位。若你的工具要按调用者 authority 收紧文件访问，得在工具层（tools-api 的 risk/minLevel）做，不能指望 storage。

### SSRF 与 storage 无关，但勿混淆

`isStorageUri`（`:279-283`）刻意把 `http/https/file`（`RESERVED_URI_SCHEMES`，`:270`）排除在 storage URI 之外——这些 scheme 走专门读取路径（外网抓取用 `safeFetch` / util-network-guard）。消费者拿到一条 URI 时应先 `isStorageUri` 分流：storage URI 走 gateway，外网 URL 走 `safeFetch`，不要把外部 URL 喂给 storage，也不要让 storage 去碰网络。详见 [docs/concepts/security-model.md](../concepts/security-model.md)。

### data 根：默认不可删 + 持久化原子写

内置 `data` 根默认 `deletable: false`（`plugin-storage-local/src/index.ts:74-79`）——它存放 users.json / scheduler-jobs / skills / persona 等关键持久化数据，参考实现对写操作做「临时文件 + rename」原子覆盖（`:388-397`）防半写损坏。若你实现自己的后端用于承载这些数据，应保证写的原子性与默认不可删的保守策略。

---

## 7. 边界与坑

1. **`browsable` 当前是半失效的 hint**：参考实现注释明说（`plugin-storage-local/src/index.ts:42-47`、configSchema `:131-136`）——`plugin-webui-server` 的文件页**只显示其 `fileRoot` 配置指向的那一个根**（默认 workspace），其它根即便 `browsable:true` 也不会出现在文件页里，仅供 agent/工具按 URI 寻址。别指望把某根设 `browsable` 就能在 WebUI 里浏览。
2. **rename 仅同目录改名**：`rename(uri, newName)` 的 `newName` 不能含 `/`、`\`、`.`、`..`（`:401-403`），不是「移动」。跨目录移动需 read+write+delete 组合。
3. **同名 root 静默遮蔽**：多个 provider 各注册一个 `data` 根时，gateway 按枚举顺序取首个，其余被遮蔽且不报错。用 `getStorageRootConflicts(ctx)`（`:195`）在 doctor/启动日志里暴露。
4. **watch 去抖 + 平台降级**：参考实现 `watch` 基于 `fs.watch` + 50ms 去抖，且事件统一为 `change`（`plugin-storage-local/src/index.ts:448-522`）；不支持 recursive 的平台降级为只监听顶层并打 WARN。消费者不应假定「一次写 = 一次事件」，也不应依赖事件类型细分。
5. **checkpoint 写前快照耦合**：参考实现在 write/delete/rename 前调用 `checkpoint` 服务做快照（`:290-303`、`:386`）。若你写自定义 storage 后端但希望兼容 checkpoint 回滚，需复刻这一 `beforeMutate` 钩子；否则该后端的写操作不可回滚。

---

## 8. 交叉链接

- 概念：[storage-uri-grammar](../concepts/storage-uri-grammar.md)（URI 文法，先读）、[service-model](../concepts/service-model.md)、[lazy-service-access](../concepts/lazy-service-access.md)、[manifest-metadata](../concepts/manifest-metadata.md)、[security-model](../concepts/security-model.md)。
- 内核：[core/service.md](../core/service.md)（DI / ServicePriority / per-entry provide）、[core/authority.md](../core/authority.md)（与权限位的区别）、[core/tools.md](../core/tools.md)（工具层 risk/minLevel 才是按调用者收紧的地方）、[core/context.md](../core/context.md)（`provide` / `getAllServices`）。

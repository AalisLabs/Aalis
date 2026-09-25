# storage 服务

**定位**：命名根（named root）+ storage URI（`<root>:/path`）的文件后端——为宿主机若干目录赋予稳定名称，对外提供 `read/write/delete/rename/list/stat` 等基于 URI 的文件操作，使上层无需硬编码绝对路径。

- **服务注册名**：描述符 `storage`（`name: 'storage'`），绑定接口是 `ServiceRef<StorageService>`。
- **契约包**：`@aalis/api-storage`（`packages/api-storage/src/index.ts`）。
- **参考实现**：`@aalis/plugin-storage-local`（`packages/plugin-storage-local/src/index.ts`）。
- **它不是沙箱**：见 [§6](#6-能力风险-影响安全边界)。

> 建议先阅读 URI 文法：[docs/concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)。本文聚焦如何实现 storage provider 以及如何消费该服务。

---

## 1. 契约：`StorageService` 接口

定义在 `packages/api-storage/src/index.ts`。所有方法的 `uri` 参数都是 `<root>:/相对路径`。

```ts
export interface StorageService {
  listRoots(): StorageRootInfo[];
  list(uri: string): Promise<StorageListResult>;
  stat(uri: string): Promise<StorageStat>;
  readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  readFileRange?(uri: string, start: number, end: number): Promise<Buffer>;
  createReadStream(uri: string): Promise<StorageReadStreamResult>;
  writeFile(uri: string, data: string | Buffer): Promise<void>;
  rename(uri: string, newName: string): Promise<string>;
  move(fromUri: string, toUri: string): Promise<string>;
  mkdir(uri: string): Promise<string>;
  delete(uri: string): Promise<void>;
  resolveLocalPath?(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string>;
  watch?(uri: string, listener: StorageWatchListener): StorageUnwatch;
}
```

### 关键类型

**`StorageRootInfo`**——根的标识与权限位：

```ts
export interface StorageRootInfo {
  name: string;
  label?: string;
  kind: StorageRootKind;
  browsable: boolean;
  readable: boolean;
  writable: boolean;
  deletable: boolean;
}
```

**`StorageEntry`** 与 **`StorageStat`** 字段相近，都带 `uri`/`path`/`isDirectory`/`size`/`mtime`/`ext`；`StorageStat` 额外有 `birthtime`。

**`StorageWatchEvent`**：`{ type: 'change'; uri: string; path: string }`——当前实现把创建/修改/删除统一上报为 `change`。

### 能力声明常量（可选互操作用）

`StorageCapabilities`：`{ List:'list', Read:'read', Write:'write', Delete:'delete', LocalPath:'local-path', Watch:'watch' }`。这些**不是 DI 能力声明**。它们只在 helper（`createStorageGateway` / `resolveStorageEntryForRoot`）里被解释为「按 root 的 `readable/writable/deletable` 权限位 + `resolveLocalPath`/`watch` 方法是否存在」来过滤。

---

## 2. 契约包导出的 helper

第一参均为 `ServiceRef<StorageService>`：

| 函数 | 用途 |
| --- | --- |
| `createStorageGateway(source)` | **消费者首选**：返回一个 `StorageService`，每次方法调用按 URI 自动路由到对应 root 的 entry。不注册进容器。`resolveLocalPath` / `readFileRange` / `watch` 恒定义（返回类型不带 `?`），根不支持时调用抛错。 |
| `getStorageEntries(source)` | 枚举所有 storage entry（`source.all()`）。 |
| `aggregateStorageRoots(source)` | 聚合全部 entry 的 root 列表（带 `providerId`/`provider`）。 |
| `getStorageRootConflicts(source)` | 同名 root 冲突诊断。 |
| `resolveStorageEntryForRoot(source, rootName, caps?)` / `resolveStorageByPath(source, uri, caps?)` | 按 root 名或 URI 找到负责该路径的 entry。 |
| `isStorageUri(s)` | **权威文法判定**。 |
| `parseUriRoot(uri)` / `toStorageUri(input, fallbackRoot='data')` / `parseStorageUri` / `resolveAgainstCwd` | 契约级路径文法。 |
| `isStorageNotFound(err)` | 「目标不存在」判据：有 `code` 时只认 `'ENOENT'`，没有 `code` 才退回文案正则。整份读入再整份回写的消费者据它区分「全新」与「读不出」：后者应拒写，免得一次回写冲掉读不懂的原文件。 |

---

## 3. 谁提供 / 谁消费

### 提供者（参考实现）

`@aalis/plugin-storage-local`——把 `config.roots` 里声明的若干本机目录注册为命名根。**每个 root 一个实例 + 一个容器 entry**。

### 典型消费点

文件工具组、shell、code-runner、skills、file-reader、checkpoint、memory / persona / scheduler / media / onebot / asr / authority / office 等，均经 `createStorageGateway(storage)` 消费。没有任何消费者经 DI 拿到单 root 的 `StorageService` 句柄当长期缓存。

---

## 4. 实现 provider

### 4.1 最小必须实现 vs 可选

| 必须 | 可选 |
| --- | --- |
| `listRoots` `list` `stat` `readFile` `createReadStream` `writeFile` `rename` `move` `mkdir` `delete` | `resolveLocalPath`、`watch`、`readFileRange` |

不实现可选方法时，`createStorageGateway` 会在调用方抛出明确报错，不会静默。

目标不存在时，`readFile` / `list` / `stat` / `delete` 等按路径定位的方法抛出带 `code: 'ENOENT'` 的错误；权限不足、根不可读等其它失败不得用这个 code，否则消费者会把「读不出」当成「全新」并覆盖原文件。

### 4.2 注册：`provide` + per-root entryId

```ts
for (const root of roots) {
  const scoped = new ScopedStorageService(root, logger);
  provide(storage, scoped, {
    entryId: `${lifecycle.id}/${root.name}`,
    label: root.label || `本地根 ${root.name}`,
  });
}
```

- **`entryId: ${lifecycle.id}/${root.name}`**：同一插件可注册多个 storage entry；`storage.all()` 全部枚举，gateway 按 URI 路由。
- **`priority`**：本服务靠「URI → root 名」精确路由，通常不设。同名 root 按枚举顺序首个优先：`createStorageGateway.listRoots` 去重时首个胜出，不带能力要求的调用（如 `stat`）只路由到它；但首个缺少调用所需能力（如只读根上的写）时，按能力过滤的调用仍会落到排在后面、被遮蔽的同名 root 上。冲突由 `getStorageRootConflicts` 暴露。

### 4.3 可编译的最小骨架

```ts
import {
  storage,
  type StorageListResult,
  type StorageReadStreamResult,
  type StorageRootInfo,
  type StorageService,
  type StorageStat,
} from '@aalis/api-storage';
import { definePlugin, lifecycle, provide } from '@aalis/core';

class MyRoot implements StorageService {
  root!: StorageRootInfo;
  listRoots() {
    return [this.root];
  }
  async list(_uri: string): Promise<StorageListResult> {
    throw new Error('todo');
  }
  async stat(_uri: string): Promise<StorageStat> {
    throw new Error('todo');
  }
  async readFile(_uri: string, _enc?: BufferEncoding): Promise<string | Buffer> {
    throw new Error('todo');
  }
  async createReadStream(_uri: string): Promise<StorageReadStreamResult> {
    throw new Error('todo');
  }
  async writeFile(_uri: string, _data: string | Buffer): Promise<void> {}
  async rename(uri: string, _newName: string): Promise<string> {
    return uri;
  }
  async move(_fromUri: string, _toUri: string): Promise<string> {
    throw new Error('todo');
  }
  async mkdir(_uri: string): Promise<string> {
    throw new Error('todo');
  }
  async delete(_uri: string): Promise<void> {}
}

export default definePlugin({
  name: '@aalis/plugin-storage-mybackend',
  provides: [storage],
  uses: { provide, lifecycle },
  apply({ provide, lifecycle }) {
    const root: StorageRootInfo = {
      name: 'mybackend',
      label: 'My Backend',
      kind: 'external',
      browsable: false,
      readable: true,
      writable: true,
      deletable: false,
    };
    const svc = new MyRoot();
    svc.root = root;
    provide(storage, svc, { entryId: `${lifecycle.id}/${root.name}`, label: root.label });
  },
});
```

> provider 内部务必自己做 `..` 穿越 / symlink 越界校验——契约对 URI 只规定文法，不保证安全。

---

## 5. 标准消费方式

### 5.1 gateway（推荐）

```ts
import { createStorageGateway, storage } from '@aalis/api-storage';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-storage-consumer',
  uses: { storage },
  apply({ storage }) {
    const gateway = createStorageGateway(storage);
    void gateway.readFile('data:/persona.yaml');
  },
});
```

网关每次方法调用重新枚举 `storage.all()`。构造一次网关对象可以长期持有——它不缓存某个 root 的实例。**不要把 `storage.current` 或 `storage.all()[i]` 存进字段**：提供者换人后旧引用失效（有失效逻辑则抛，无则静默成功）；关停边不保护缓存引用。

### 5.2 required 还是 optional

- 强依赖文件 → `uses: { storage }`（required）。框架保证激活时 storage 已就绪。
- 非必需增强 → `optional(storage)`；若没有任何 storage entry，`dispatch` 会抛「未知存储根」。

### 5.3 错误边界

root 名未注册时抛「未知存储根」并附已注册根列表；root 已注册、但没有提供者满足调用所需能力（如只读根上的写、不支持本地路径的根上的 `resolveLocalPath`）时抛「存储根 X 不支持 write」一类点明所缺能力的错误。网关上的 `resolveLocalPath` / `watch` 恒存在，目标根不支持时由调用本身抛错，需用 try/catch 处理；只有直接持有单个根的提供者实例（如 `resolveStorageEntryForRoot` 返回的 `instance`）时，才需要判断方法是否存在，或在查找时传 `local-path` / `watch` 能力过滤。消费者应捕获这些错误并转成对 LLM/用户友好的提示。

---

## 6. 能力/风险 → 影响（安全边界）

### `resolveLocalPath` 不是沙箱

- 把 URI 解析成宿主机**绝对路径**，交给 shell/code-runner 当 cwd 或起点用。
- 解析过程**只校验目标在声明根内**，**不约束子进程之后的访问范围**。
- **真正的隔离靠 OS 用户权限 / 容器 / OS 沙箱**，不是这一层。

### 高危直通根

参考实现允许 `{ name:'host', path:'/' }` 这种直通根——agent 即可 `host:/绝对路径` 访问宿主机任意位置。注册时会打 WARN。

### 权限位即授权语义

root 的 `readable/writable/deletable` 就是该根的访问策略。这与 authority 等级体系是**两套**机制——storage 不读 session 等级。若工具要按调用者 authority 收紧文件访问，须在工具层实现。

### SSRF 与 storage 无关

`isStorageUri` 刻意把 `http/https/file` 排除。消费者拿到一条 URI 时应先分流：storage URI 走 gateway，外网 URL 走 `safeFetch`。

### data 根：可删 + 持久化原子写

内置 `data` 根默认 `deletable: true`——`/clear` 的附件清理依赖它。`deletable` 是后端能力位而非权限闸：agent 侧的删除面由各工具自身的权限档把关。参考实现对写操作做「临时文件 + rename」原子覆盖。

---

## 7. 边界与注意事项

1. **`browsable` 当前是部分生效的 hint**：`plugin-webui-server` 的文件页**只显示其 `fileRoot` 配置指向的那一个根**。
2. **rename 仅同目录改名**。同根跨目录移动改用 `move`。
3. **同名 root 静默遮蔽**：用 `getStorageRootConflicts(storage)` 暴露。
4. **watch 去抖 + 平台降级**：事件统一为 `change`。消费者不应假定「一次写 = 一次事件」。参考实现的监听器归提供者的这次激活所有，提供者关闭（重启、改配置、卸载）时一并关闭；需要持续监听的消费者用 `storage.follow` 在新提供者上重挂。
5. **checkpoint 写前快照耦合**：自定义后端若希望兼容 checkpoint 回滚，需复刻 `beforeMutate` 钩子。checkpoint 按根的 `kind` 决定是否记账：`data` / `tmp` / `pluginData` / `logs` 不记账。

---

## 8. 交叉链接

- 概念：[storage-uri-grammar](../concepts/storage-uri-grammar.md)、[service-model](../concepts/service-model.md)、[lazy-service-access](../concepts/lazy-service-access.md)、[manifest-metadata](../concepts/manifest-metadata.md)、[security-model](../concepts/security-model.md)。
- 内核：[core/service.md](../core/service.md)、[plugins/plugin-authority.md](../plugins/plugin-authority.md)、[plugins/plugin-tools.md](../plugins/plugin-tools.md)、[core/context.md](../core/context.md)。

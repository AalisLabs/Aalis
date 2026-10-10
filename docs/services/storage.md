# storage 服务

**定位**：命名根（named root）+ storage URI（`<root>:/path`）的文件后端——为宿主机若干目录赋予稳定名称，对外提供 `read/write/delete/rename/list/stat` 等基于 URI 的文件操作，使上层无需硬编码绝对路径。

- **服务注册名**：描述符 `storage`（`name: 'storage'`），业务层是 `BoundStorage`：调用转发给选中的存储提供者，另带本插件私有目录的视图 `own`。
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
  writeFile(uri: string, data: string | Buffer, options?: StorageWriteOptions): Promise<void>;
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

**`StorageWriteOptions`**：`{ secret?: boolean }`——`secret` 表示内容是凭据（访问 token 一类），只给运行 Aalis 的系统用户读写。

### 业务层 `BoundStorage`

```ts
type StorageMethods = StorageService & Required<Pick<StorageService, 'resolveLocalPath' | 'readFileRange' | 'watch'>>;

export type OwnStorage = Omit<StorageMethods, 'listRoots'> & {
  uri(path?: string): string;
};

export interface BoundStorage extends StorageMethods {
  readonly own: OwnStorage;
}
```

- `caps.storage.use` 的调用转发给本插件选中的存储提供者。`resolveLocalPath` / `readFileRange` / `watch` 在业务层上恒定义（类型不带 `?`）：选中的那一家不支持时，调用本身抛「存储提供者不支持 X」，调用方不必先判方法是否存在。
- `own` 是本插件私有目录 `pluginData:/<插件名>/` 上的存储视图。插件名取定义名的最后一段、去掉 `plugin-` 前缀（`@aalis/plugin-paper` → `paper`）；同一插件的多个实例共用这个目录，需要区分时由插件自己分子目录。方法与 `StorageService` 相同（没有 `listRoots`），路径参数相对这个目录：规范化之后越出目录的（`..` 越过目录）、宿主机绝对路径与存储地址都抛错；返回值里的地址是完整的存储地址。`own.uri(path)` 给出相对路径对应的完整存储地址（交给别处、写进记录时用），不给参数即目录本身。

---

## 2. 契约包导出的 helper

路径文法与判据（纯函数，不吃服务）：

| 函数 | 用途 |
| --- | --- |
| `isStorageUri(s)` | **权威文法判定**。 |
| `parseUriRoot(uri)` / `toStorageUri(input, fallbackRoot='data')` / `parseStorageUri` / `resolveAgainstCwd` | 契约级路径文法。`toStorageUri` 遇本机路径（宿主机绝对路径与 `~/…`）抛配置错误，写明要填 storage URI 并举例。 |
| `isHostAbsolutePath(input)` | 宿主机绝对路径（`/abs`、`C:\path`、`C:/path`）判据。 |
| `isStorageNotFound(err)` | 「目标不存在」判据：有 `code` 时只认 `'ENOENT'`，没有 `code` 才退回文案正则。整份读入再整份回写的消费者据它区分「全新」与「读不出」：后者应拒写，免得一次回写冲掉读不懂的原文件。 |

---

## 3. 谁提供 / 谁消费

### 提供者（参考实现）

`@aalis/plugin-storage-local`——把 `config.roots` 里声明的用户根（缺省只有 `workspace`），以及按家目录布局派生的内部根（`data`、`pluginData`、`tmp`、`cache`、`logs`、`personas`、`skills`、`workflows`、`paper`、`public`）注册为命名根。全部根就绪之后整体登记**一个**提供者，根在它内部按 URI 根名路由；根名不认识时抛「未知存储根: x（已注册根: …）」。

### 典型消费点

文件工具组、shell、code-runner、skills、file-reader、checkpoint、memory / persona / scheduler / media / onebot / asr / authority / office 等，均经 `caps.storage.use` 消费。插件自己的私有数据（file-reader、paper、publish-review、reach、session-server、tools、webui-server、works-site）经 `caps.storage.use.own` 读写。

---

## 4. 实现 provider

### 4.1 最小必须实现 vs 可选

| 必须 | 可选 |
| --- | --- |
| `listRoots` `list` `stat` `readFile` `createReadStream` `writeFile` `rename` `move` `mkdir` `delete` | `resolveLocalPath`、`watch`、`readFileRange` |

不实现可选方法时，消费方经业务层调用会抛「存储提供者不支持 X」，不会静默。

`writeFile` 带 `secret` 时内容不得落成别的系统用户读得到的文件：本地文件以 0600 建出、覆写已有文件时一并收紧（参考实现的临时文件建出来就是 0600）；做不到的提供者拒写。

目标不存在时，`readFile` / `list` / `stat` / `delete` 等按路径定位的方法抛出带 `code: 'ENOENT'` 的错误；权限不足、根不可读等其它失败不得用这个 code，否则消费者会把「读不出」当成「全新」并覆盖原文件。

### 4.2 注册：一个提供者，内部按根路由

```ts
// 全部根就绪之后整体登记，依赖方激活时就看得到每一个根
caps.provide.use(storage, new LocalStorage(scoped), { label: '本地存储' });
```

- **一个提供者管全部根**：`listRoots()` 返回全部根，每个数据方法按 URI 的根名分给对应的根，根名不认识时抛「未知存储根」并列出已有的根。消费方的 `caps.storage.use` 只打到选中的那一家，一个后端的全部根因此要在同一个提供者里。
- **全部根就绪之后再 `provide`**：依赖方激活时看得到每一个根，不会撞上只有一部分根的提供者。
- **`priority`**：通常不设。装了多个 storage 提供者时，每个消费方按「本插件偏好 > 全局偏好 > 优先级 > 注册顺序」选中一家，`use` 只打到它；另一家的根要经 `caps.storage.of(id)` 访问，不存在跨提供者的根合并。

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
import { definePlugin, provide } from '@aalis/core';

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
  uses: { provide },
  apply({ provide }) {
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
    provide.use(storage, svc, { label: root.label });
  },
});
```

> provider 内部务必自己做 `..` 穿越 / symlink 越界校验——契约对 URI 只规定文法，不保证安全。

---

## 5. 标准消费方式

### 5.1 业务句柄 `caps.storage.use`

```ts
import { storage } from '@aalis/api-storage';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-storage-consumer',
  uses: { storage },
  apply({ storage }) {
    void storage.use.readFile('data:/persona.yaml');
    // 私有数据：落到 pluginData:/example-storage-consumer/state.json
    void storage.use.own.writeFile('state.json', '{}');
  },
});
```

业务句柄是活的：每次调用都转发给本插件此刻选中的存储提供者，存进字段也会跟着换人。一段操作要固定同一家时取 `storage.list().find(p => p.selected)?.use`。**不要把 `services.use.get(storage)` 拿到的原始实例存进字段**：提供者换人后旧引用失效（有失效逻辑则抛，无则静默成功）；关停边不保护这份引用。

### 5.2 required 还是 optional

- 强依赖文件 → `uses: { storage }`（required）。框架保证激活时 storage 已就绪。
- 非必需增强 → `optional(storage)`，调用前先看 `storage.present`；选不到存储提供者时访问业务句柄的成员同步抛 `ServiceUnavailableError`。

### 5.3 错误边界

root 名不认识时抛「未知存储根」并附已注册根列表；根的权限位不允许这次操作（如只读根上的写）时抛「存储根 X 不允许该操作 (writable)」一类的错误（参考实现）。业务层上的 `resolveLocalPath` / `readFileRange` / `watch` 恒存在，提供者不支持时由调用本身抛错，需用 try/catch 处理；只有经 `services.use.get(storage)` 直接持有提供者原始实例时，才需要判断方法是否存在。`own` 收到越出私有目录的路径、宿主机绝对路径或存储地址时同样抛错。消费者应捕获这些错误并转成对 LLM/用户友好的提示。

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

`isStorageUri` 刻意把 `http/https/file` 排除。消费者拿到一条 URI 时应先分流：storage URI 走 `caps.storage.use`，外网 URL 走 `safeFetch`。

### data 根：可删 + 持久化原子写

内部根 `data`（家目录的 `state/`）可删——`/clear` 的附件清理依赖它。`deletable` 是后端能力位而非权限闸：agent 侧的删除面由各工具自身的权限档把关。参考实现对写操作做「临时文件 + rename」原子覆盖；覆写沿用原文件的权限位，凭据（`secret`）一律 0600。

### 宿主控制文件

参考实现在执行点兜底：不管经哪个根，家目录的 `secrets.yaml` 读写都拒绝，`aalis.config.yaml` 拒绝写入（可以读）；按 (dev, ino) 比对，硬链接与符号链接都挡得住。删除、移动、改名目录，或经 `resolveLocalPath` 以写、删的方式交出目录的本地路径时，子树里含受保护的文件也拒绝（以读的方式交出目录不查子树）。细节见 [plugin-storage-local](../plugins/plugin-storage-local.md#宿主控制文件)。

---

## 7. 边界与注意事项

1. **`browsable` 只是给文件浏览器类界面的 hint**：WebUI 没有文件浏览页，不读它。
2. **rename 仅同目录改名**。同根跨目录移动改用 `move`。
3. **同名 root**：参考实现在一个提供者里管全部根，`roots` 里与内置根同名或重复的项被跳过并告警，不存在遮蔽。
4. **watch 去抖 + 平台降级**：事件统一为 `change`。消费者不应假定「一次写 = 一次事件」。参考实现的监听器归提供者的这次激活所有，提供者关闭（重启、改配置、卸载）时一并关闭；需要持续监听的消费者用 `caps.storage.follow` 在新提供者上重挂。
5. **checkpoint 写前快照耦合**：自定义后端若希望兼容 checkpoint 回滚，需复刻 `beforeMutate` 钩子：每次改动前经 `services.use.get(checkpoint)`（描述符来自 `@aalis/api-checkpoint`）取服务，在场就调 `beforeMutate`（写入不在回合里时它直接返回，不读原文件），见 [api-checkpoint](../api/api-checkpoint.md)。checkpoint 按根的 `kind` 决定是否记账：`data` / `pluginData` / `tmp` / `cache` / `logs` / `paper` / `public` / `self` 不记账，其余（如 `workspace`、`custom`）记账。

---

## 8. 交叉链接

- 概念：[storage-uri-grammar](../concepts/storage-uri-grammar.md)、[service-model](../concepts/service-model.md)、[lazy-service-access](../concepts/lazy-service-access.md)、[manifest-metadata](../concepts/manifest-metadata.md)、[security-model](../concepts/security-model.md)。
- 内核：[core/service.md](../core/service.md)、[plugins/plugin-authority.md](../plugins/plugin-authority.md)、[plugins/plugin-tools.md](../plugins/plugin-tools.md)、[core/context.md](../core/context.md)。

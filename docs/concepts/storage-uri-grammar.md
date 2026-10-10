# 存储 URI 文法（storage URI grammar）

**适用对象**：编写/维护 Aalis 插件的第三方作者。
**相关源码**：`packages/api-storage/src/index.ts`（契约 + 权威 helper）、`packages/plugin-storage-local/src/index.ts`（参考实现）。

## 概述：插件作者为什么需要它

Aalis 里所有「文件」都不用宿主机绝对路径表示，而是用一条 **storage URI**：

```
<root>:/<相对路径>
例：data:/images/x.jpg   workspace:/notes/todo.md   logs:/app.log
```

`<root>` 是一个**命名根**（named root）：存储后端给宿主机某个目录起一个稳定的名字，
上层只认这个名字，不知道也无需知道它落在磁盘哪里。配置、工具调用、消息附件因此不必
硬编码 `/Users/xxx/...`，跨机器、跨部署也不会失效。

作为插件作者，你会在三处场景遇到它：

1. **消费文件**：你拿到一条 URI（来自附件、配置、工具参数），要读/写它 → 用 storage 服务的业务句柄 `caps.storage.use`。
2. **判别字符串**：你收到一个可能是 URI、可能是 http URL、可能是 base64 data-URI 的字符串，要分流 → 用 `isStorageUri`。
3. **归一配置**：用户在你的 configSchema 里填了个路径/裸名，你要把它变成合法 URI → 用 `toStorageUri`。

**核心原则：文法与判别一律复用 `@aalis/api-storage` 导出的 helper，不要各自重写正则。**
这几个函数是「权威文法」（authoritative grammar），全体内置消费者（onebot / media / asr / persona /
checkpoint …）都复用它们。自行重写一份正则，迟早与它们漂移，触发下文「常见错误与边界情形」列出的问题。

---

## 文法规则

### 1. 基本形态：`<root>:/<path>`

正则定义在 `index.ts`：

```ts
const STORAGE_URI_RE = /^[a-zA-Z][a-zA-Z0-9_-]*:\//;
```

- 根名（scheme）**以字母开头**，后接字母/数字/下划线/连字符。工具路径（`resolveAgainstCwd`）与配置路径（`toStorageUri`）都把 `X:/…` 这种单字母形态判为 Windows 盘符绝对路径并拒绝，所以单字母根名在两侧都不可达——给根起名至少用两个字符。
- 紧跟 `:/`（冒号 + 斜杠）——这一点是整套歧义消解的关键（见下文 data 根）。
- `:/` 之后是根内相对路径。前导斜杠会被各后端归一掉（`plugin-storage-local` 的 `normalizeRelPath`，`index.ts`）。

后端对根名的合法性还有一道更严的校验（`plugin-storage-local` 的 `ROOT_NAME_RE`，`index.ts`，
等价于 `/^[a-zA-Z][a-zA-Z0-9_-]*$/`），非法根名会被跳过并打 warn。

### 2. 保留 scheme：`http` / `https` / `file` 不是 storage URI

定义在 `index.ts`：

```ts
const RESERVED_URI_SCHEMES = new Set(['http', 'https', 'file']);
```

这三个 scheme 形态上同样类似 `xxx:/...`，但它们**另有专门的读取路径**，不归 storage 管：

- `http(s)://` → 经 `safeFetch`（`@aalis/util-network-guard`，SSRF 守卫的出网通道）下载。
- `file://` / 裸本地路径 → 经 `readExternalFile`（任意 OS 路径读取，受 daemon 信任边界约束）。

`isStorageUri` 在正则匹配后**还会**取出 scheme 小写比对这个保留集（`index.ts`），命中即判 false。
所以 `http://...`、`HTTPS://...`、`file:///etc/passwd` 都不会被误当成 storage URI。

### 3. `data:/` 与标准 data-URI（易混淆的一处）

存储根名 `data`（`plugin-storage-local` 的内部根之一，对应家目录的 `state/`，见 `index.ts`）和
浏览器/WebUI 上传常见的 base64 **data-URI** 前缀冲突。文法靠 `:/` 天然区分二者：

| 字符串 | 形态 | 是 storage URI？ |
|---|---|---|
| `data:/images/x.jpg` | 冒号后**紧跟 `/`** | 是，根名 `data`，路径 `images/x.jpg` |
| `data:image/png;base64,iVBOR...` | 冒号后跟 **MIME 类型** | 否，正则 `:\/` 不匹配 `data:image`（`i` 不是 `/`） |
| `data:text/plain;base64,SGk=` | 同上 | 否 |

判别依赖 `STORAGE_URI_RE` 中的 `:\/`：`data:/` 命中，`data:image/...` 不命中（注释见 `index.ts`）。
真实消费侧的分流见 `plugin-media/src/service.ts`：先 `isStorageUri(data)`（命中即走 storage 路径），
未命中再以 `data.startsWith('data:')` 按 base64 data-URI 解码。**顺序不可颠倒：先判 `isStorageUri`，再判 data-URI。**

---

## 权威 helper（复用，勿重写）

全部从 `@aalis/api-storage` 导出。

### `isStorageUri(s: string): boolean` — 判别

`index.ts`。判定一个字符串是否 storage URI。用于把混合来源的字符串分流到
storage / safeFetch / readExternalFile / data-URI 解码不同分支。

```ts
import { isStorageUri } from '@aalis/api-storage';

if (isStorageUri(data)) {
  const buf = await caps.storage.use.readFile(data); // storage 路径
} else if (data.startsWith('http://') || data.startsWith('https://')) {
  const res = await safeFetch(data);                 // SSRF 守卫出网
} else if (data.startsWith('data:')) {
  // base64 data-URI，自行解码
}
```

### `parseUriRoot(uri: string): string` — 取根名

`index.ts`。`data:/images/x.jpg` → `'data'`。**非 `<根名>:/...` 形态会抛错**
（按 `:/` 的位置判定，`idx <= 0` 即非法）。

```ts
import { parseUriRoot } from '@aalis/api-storage';
parseUriRoot('workspace:/a/b.txt'); // 'workspace'
parseUriRoot('not-a-uri');          // throws: 存储 URI 不合法
```

> 取根名后想拿到根内相对路径，用 `uri.slice(root.length + 2)`（跳过 `root` + `:/`），
> 见 `plugin-media/src/service.ts`。

### `toStorageUri(input, fallbackRoot = 'data'): string` — 归一

`index.ts`。把用户在配置里填的路径/裸名归一成合法 URI。**契约级文法**，
memory / vectorstore / persona 等后端消费者复用它。四条规则：

| 输入 | 输出 | 说明 |
|---|---|---|
| 本机路径：宿主机绝对路径（`/abs`、`C:\path`、`C:/path`，判据是 `isHostAbsolutePath`）与家目录简写 `~/…` | 抛配置错误 | 写明要填 storage URI，并按 fallbackRoot 与路径末段举例（`/private/tmp/aalis.db` → 如 `data:/aalis.db`）；不带堆栈 |
| 已含 `:/`（如 `data:/x`） | 原样返回 | 已是 URI |
| `foo/bar`（含 `/`） | `foo:/bar` | 首段当根名 |
| `name`（单段裸名，无 `/`） | `data:/name` | **裸名归到 fallbackRoot 的相对路径，不当成根名** |

```ts
import { toStorageUri } from '@aalis/api-storage';
toStorageUri('data:/checkpoints');  // 'data:/checkpoints'（原样）
toStorageUri('checkpoints/x');      // 'checkpoints:/x'（首段当根）
toStorageUri('checkpoints');        // 'data:/checkpoints'（单段 → data 根相对路径）
toStorageUri('persona', 'data');    // 'data:/persona'
```

输入还会先 `trim()` 并剥掉前导 `./`。本机路径直接报配置错误：若按首段当根名，首段与某个根同名时（如 `/data/x`）会悄悄落到那个根里，
不同名时只会撞上「未知存储根」。要用存储根以外的目录，先在本地存储插件的 `roots` 里加一个指向它的根，并打开它的「允许写」
（数据库、索引等要写入）；这个根文件工具也能访问。
真实用法：`plugin-memory-sqlite/src/index.ts` 的 `toUri`（非空走 `toStorageUri(s)`，留空按实例派生 `data:/aalis.db` / `data:/aalis-<后缀>.db`）、
`plugin-persona/src/index.ts` 的 `toStorageUri(personasDirRaw)`。

> **单段裸名归一的设计动机**（`index.ts`）：如果把单段裸名当**根名**处理（→ `name:/`），
> 存储提供者找不到这个根就抛「未知存储根」。所以约定单段名是 `data` 根下的相对路径——这通常是用户想要的。

### 业务句柄 `caps.storage.use` — 跨根调用

`uses` 里声明 `storage` 之后，`caps.storage.use` 是一个 `StorageService` 形状的活句柄（`BoundStorage`，`index.ts`）：调用转发给选中的存储提供者，由提供者按 URI 的根名分给对应的根。参考实现 `@aalis/plugin-storage-local` 只登记一个提供者，全部根都在它内部。tools / shell / checkpoint 这类要透明跨多个根调用的场景，直接用这个句柄。

```ts
// apply({ storage }) 内
await storage.use.writeFile('data:/notes/x.md', 'hi'); // 落到 data 根
await storage.use.readFile('workspace:/a.txt');        // 落到 workspace 根
```

URI 即标识 + 路由 key，调用方无需关心根落在磁盘哪里。根名不认识时抛
「未知存储根: X（已注册根: ...）」；根的权限位不允许这次操作（如只读根上的写）时抛
「存储根 X 不允许该操作 (writable)」一类的错误（`plugin-storage-local/src/index.ts`）。业务层恒定义 `resolveLocalPath` / `readFileRange` / `watch`，
提供者不支持时由调用本身抛错。插件自己的私有数据经 `caps.storage.use.own` 读写：它是 `pluginData:/<插件名>/` 上的视图，
路径参数相对这个目录，见 [storage 服务](../services/storage.md)。

---

## 提供端（实现存储后端时）

### 一个提供者，内部按根路由

参考实现只登记**一个** storage 提供者：全部根就绪之后整体登记，依赖方激活时就看得到每一个根；根在它内部按 URI 根名路由（`plugin-storage-local/src/index.ts` 的 `LocalStorage`）：

```ts
caps.provide.use(storage, new LocalStorage(scoped), { label: '本地存储' });
```

URI → 根的路由在提供者内部完成。后端只要：

- `listRoots()` 返回自己提供的全部根（含权限位）。
- 每个数据方法收到 URI 后按根名分给对应的根，再 parse 出相对路径并校验（参考实现每个根的 `parseSelfUri`，`index.ts`）；根名不认识时抛「未知存储根」并列出已有的根。

### 权限位携带在 `StorageRootInfo` 上

根的真实权限由 `StorageRootInfo` 的 `readable` / `writable` / `deletable` 位携带（`index.ts`），
**不是**靠 DI 能力声明（0.5.0 的能力选择层已删除）。提供者在每个操作前按这些位核对，不允许就抛错；
消费方不按能力挑提供者。

---

## 「存储不是沙箱」边界

这是审计反复强调、也最容易被插件作者误解的一点，接口注释中已明确写出（`index.ts`、
`plugin-storage-local/src/index.ts`）：

- 存储层做三件事：**命名根**、**路径解析**（根内 `..` 穿越保护 + symlink realpath 校验）、**审计点**（读写删过 logger）。参考实现另有一道宿主控制文件兜底：不能经存储读写家目录的 `secrets.yaml`、改写 `aalis.config.yaml`（见 [plugin-storage-local](../plugins/plugin-storage-local.md#宿主控制文件)）。
- 路径校验只防**上层代码意外越界的 bug**（如 `workspace:/../../etc/passwd` 会被 `isInside` 拒掉，
  `plugin-storage-local/src/index.ts`），**不是用来对抗恶意子进程**。

`resolveLocalPath(uri, access)`（`index.ts`）把 URI 解析成宿主机绝对路径，交给必须用本地路径的
子进程（shell / code-runner）。**解析过程校验目标在声明的根内，但不会限制后续子进程的访问范围**：

```ts
// 这个绝对路径只是「工作目录/起点」，不是沙箱边界
const cwd = await caps.storage.use.resolveLocalPath('workspace:/proj', 'read');
// 一旦 run_python / shell 拿到 cwd，子进程能访问当前 OS 用户可访问的任何文件
```

真正的隔离必须依赖 **OS 用户权限或容器**（参考 `code-sandbox-os`，也只是 OS 级 bwrap/seatbelt，非强隔离），
不能指望 storage 这一层。把 `resolveLocalPath` 的返回值当沙箱边界用，就是这类「困惑代理」（confused-deputy）漏洞的来源。

---

## 常见错误与边界情形（审计标注过的）

1. **勿各自重写正则**。`isStorageUri`/`parseUriRoot`/`toStorageUri` 是权威文法，全体消费者复用。
   自行用 `s.includes(':')` 之类判别，会把 `data:image/...;base64,` 误判成 storage URI（漏了 `:/`），
   或让 `http://` 漏过保留 scheme 检查。

2. **`data:/` 与 base64 data-URI 的分流顺序**：先 `isStorageUri(data)`，**再** `data.startsWith('data:')`。
   反过来会把 `data:/...` 当成残缺 data-URI 处理。见 `plugin-media/src/service.ts`。

3. **单段裸名不当根名**。`toStorageUri('checkpoints')` → `data:/checkpoints`（data 根相对路径），
   不是 `checkpoints:/`。想让它当根名，需显式写 `checkpoints/`（带斜杠）或 `checkpoints:/`。

4. **`parseUriRoot` 会抛**。对非 `<根名>:/...` 形态（`idx <= 0`）直接抛错（`index.ts`）；
   不确定输入时先 `isStorageUri` 守卫，或包 try/catch。

5. **未知根抛错**。存储提供者找不到根名时抛「未知存储根」（`plugin-storage-local/src/index.ts`）。
   `toStorageUri` 的单段裸名归到 `data` 根，正是为了避免把裸名当根名后必然命中这个错误。

6. **同名根与多个提供者**：参考实现在一个提供者里管全部根，`roots` 里与内置根同名或重复的项被跳过并告警
   （`plugin-storage-local/src/index.ts`），不存在同名根遮蔽。装了多个 storage 提供者时，`caps.storage.use` 只打到
   选中的那一家，另一家的根要经 `caps.storage.of(id)` 访问。

7. **不是所有后端都支持 `resolveLocalPath` / `watch`**：远程协议或纯虚拟根的后端可能不实现这两个可选方法
   （`index.ts`）。业务层（`caps.storage.use`）上这两个方法恒存在，提供者不支持时由调用本身抛错（`index.ts`），
   需用 try/catch 处理，不要假定所有根都能落地到本地路径；只有经 `services.use.get(storage)` 直接持有提供者实例时，才需要判断方法是否存在。

8. **路径分隔符**：URI 路径统一用 `/`；后端在归一时会把 `\\` 转成 `/`（`plugin-storage-local` 的 `toUri`，`index.ts`）。

---

## 交叉链接

- 服务用法、各根的语义与配置：**`docs/services/storage.md`**（forward-ref，存储服务详解）与 [plugin-storage-local](../plugins/plugin-storage-local.md)。
- DI 服务模型（同名多 provider 选优、per-entry 粒度、`provide.use` / 选择层 / `services.get` 仅取 name）：
  `docs/core/service.md`。
- 鉴权（数字等级 + HITL 确认；deniedCapabilities 硬禁；与存储根权限位正交）：
  `docs/plugins/plugin-authority.md`、`docs/services/authority.md`。
- SSRF 守卫出网通道 `safeFetch`（`http(s)://` 分支去向）：`@aalis/util-network-guard`（`docs/utils/network-guard.md`）。
- OS 级沙箱（与「存储不是沙箱」对照）：`docs/plugins/plugin-code-sandbox-os.md`、`docs/plugins/plugin-tool-code-runner.md`。
- 消费侧示例：`docs/plugins/plugin-adapter-onebot.md`、`docs/plugins/plugin-file-reader.md`、`docs/plugins/plugin-persona.md`。

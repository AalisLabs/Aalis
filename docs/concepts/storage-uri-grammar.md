# 存储 URI 文法（storage URI grammar）

**适用对象**：写/维护 Aalis 插件的第三方作者。
**相关源码**：`packages/plugin-storage-api/src/index.ts`（契约 + 权威 helper）、`packages/plugin-storage-local/src/index.ts`（参考实现）。

## 概述：为什么插件作者要关心它

Aalis 里所有「文件」都不用宿主机绝对路径表示，而是用一条 **storage URI**：

```
<root>:/<相对路径>
例：data:/images/x.jpg   workspace:/notes/todo.md   logs:/app.log
```

`<root>` 是一个**命名根**（named root）——存储后端把宿主机某个目录起了个稳定的名字，
上层只认这个名字，不知道也不该知道它落在磁盘哪里。这样配置、工具调用、消息附件里
就不会到处硬编码 `/Users/xxx/...`，换机器/换部署也不破。

作为插件作者你会在三个地方碰到它：

1. **消费文件**：你拿到一条 URI（来自附件、配置、工具参数），要读/写它 → 用 storage service 或 `createStorageGateway`。
2. **判别字符串**：你收到一个可能是 URI、可能是 http URL、可能是 base64 data-URI 的字符串，要分流 → 用 `isStorageUri`。
3. **归一配置**：用户在你的 configSchema 里填了个路径/裸名，你要把它变成合法 URI → 用 `toStorageUri`。

**核心纪律：文法和判别一律复用 `@aalis/plugin-storage-api` 导出的 helper，不要各自重抄正则。**
这几个函数是「权威文法」（authoritative grammar），全体内置消费者（onebot / media / asr / persona /
checkpoint …）都复用它们；你重抄一份正则迟早和它们漂移，踩到下面「陷阱」一节里那些坑。

---

## 文法规则

### 1. 基本形态：`<root>:/<path>`

正则定义在 `index.ts:268`：

```ts
const STORAGE_URI_RE = /^[a-zA-Z][a-zA-Z0-9_-]*:\//;
```

- 根名（scheme）**以字母开头**，后接字母/数字/下划线/连字符。
- 紧跟 `:/`（冒号 + 斜杠）——这一点是整套歧义消解的关键（见下文 data 根）。
- `:/` 之后是根内相对路径。前导斜杠会被各后端归一掉（`plugin-storage-local` 的 `normalizeRelPath`，`index.ts:219`）。

后端对根名的合法性还有一道更严的校验（`plugin-storage-local` 的 `ROOT_NAME_RE`，`index.ts:622`，
等价于 `/^[a-zA-Z][a-zA-Z0-9_-]*$/`），非法根名会被跳过并打 warn。

### 2. 保留 scheme：`http` / `https` / `file` 不是 storage URI

定义在 `index.ts:270`：

```ts
const RESERVED_URI_SCHEMES = new Set(['http', 'https', 'file']);
```

这三个 scheme 形态上也长得像 `xxx:/...`，但它们**另有专门读取路径**，不归 storage：

- `http(s)://` → 经 `safeFetch`（`@aalis/util-network-guard`，SSRF 守卫的出网通道）下载。
- `file://` / 裸本地路径 → 经 `readExternalFile`（任意 OS 路径读取，受 daemon 信任边界约束）。

`isStorageUri` 在正则匹配后**还会**取出 scheme 小写比对这个保留集（`index.ts:280-282`），命中即判 false。
所以 `http://...`、`HTTPS://...`、`file:///etc/passwd` 都不会被误当成 storage URI。

### 3. `data:/` vs 标准 data-URI（最容易混的一处）

存储根名 `data`（内置 5 根之一，见 `plugin-storage-local` 默认配置 `index.ts:71-79`）和
浏览器/WebUI 上传常见的 base64 **data-URI** 前缀冲突。文法靠 `:/` 天然区分二者：

| 字符串 | 形态 | 是 storage URI？ |
|---|---|---|
| `data:/images/x.jpg` | 冒号后**紧跟 `/`** | ✅ 是，根名 `data`，路径 `images/x.jpg` |
| `data:image/png;base64,iVBOR...` | 冒号后跟 **MIME 类型** | ❌ 否，正则 `:\/` 不匹配 `data:image`（`i` 不是 `/`） |
| `data:text/plain;base64,SGk=` | 同上 | ❌ 否 |

判别全靠 `STORAGE_URI_RE` 里那个 `:\/`：`data:/` 命中，`data:image/...` 不命中（注释见 `index.ts:272-278`）。
真实消费侧分流见 `plugin-media/src/service.ts:266-271`：先 `isStorageUri(data)`（命中即 storage 路径），
不命中再 `data.startsWith('data:')` 当 base64 data-URI 解码。**顺序很重要——先问 `isStorageUri` 再问 data-URI。**

---

## 权威 helper（用这些，别重抄）

全部从 `@aalis/plugin-storage-api` 导出。

### `isStorageUri(s: string): boolean` — 判别

`index.ts:279`。判定一个字符串是否 storage URI。用于把混合来源的字符串分流到
storage / safeFetch / readExternalFile / data-URI 解码不同分支。

```ts
import { isStorageUri } from '@aalis/plugin-storage-api';

if (isStorageUri(data)) {
  const buf = await storage.readFile(data);      // storage 路径
} else if (data.startsWith('http://') || data.startsWith('https://')) {
  const res = await safeFetch(data);             // SSRF 守卫出网
} else if (data.startsWith('data:')) {
  // base64 data-URI，自行解码
}
```

### `parseUriRoot(uri: string): string` — 取根名

`index.ts:286`。`data:/images/x.jpg` → `'data'`。**非 `<根名>:/...` 形态会抛错**
（按 `:/` 的位置判定，`idx <= 0` 即非法）。

```ts
import { parseUriRoot } from '@aalis/plugin-storage-api';
parseUriRoot('workspace:/a/b.txt'); // 'workspace'
parseUriRoot('not-a-uri');          // throws: 存储 URI 不合法
```

> 取根名后想拿到根内相对路径，用 `uri.slice(root.length + 2)`（跳过 `root` + `:/`），
> 见 `plugin-media/src/service.ts:267-268`。

### `toStorageUri(input, fallbackRoot = 'data'): string` — 归一

`index.ts:301`。把用户在配置里填的路径/裸名归一成合法 URI。**契约级文法**，
memory / vectorstore / checkpoint / scheduler / persona 等全体后端消费者复用它。三条规则：

| 输入 | 输出 | 说明 |
|---|---|---|
| 已含 `:/`（如 `data:/x`） | 原样返回 | 已是 URI |
| `foo/bar`（含 `/`） | `foo:/bar` | 首段当根名 |
| `name`（单段裸名，无 `/`） | `data:/name` | **裸名归到 fallbackRoot 的相对路径，不当成根名** |

```ts
import { toStorageUri } from '@aalis/plugin-storage-api';
toStorageUri('data:/checkpoints');  // 'data:/checkpoints'（原样）
toStorageUri('checkpoints/x');      // 'checkpoints:/x'（首段当根）
toStorageUri('checkpoints');        // 'data:/checkpoints'（单段 → data 根相对路径）
toStorageUri('persona', 'data');    // 'data:/persona'
```

输入还会先 `trim()` 并剥掉前导 `./` 和 `/`（`index.ts:303-305` 的 `replace(/^\.?\/+/, '')`）。
真实用法：`plugin-checkpoint/src/service.ts:502` 的 `toStorageUri(s) : 'data:/checkpoints'`、
`plugin-persona/src/index.ts:461` 的 `toStorageUri(personasDirRaw)`。

> **单段裸名归一的设计动机**（`index.ts:295-298`）：如果把单段裸名当**根名**处理（→ `name:/`），
> gateway 找不到这个根就抛「未知根」。所以约定单段名是 `data` 根下的相对路径——这通常是用户想要的。

### `createStorageGateway(ctx): StorageService` — 跨根句柄

`index.ts:317`。返回一个 `StorageService`，每次方法调用按 URI 自动路由到对应后端 entry。
**它不注册进 ServiceContainer**——纯本地构造，没有 facade entry。适用于 tools / shell / checkpoint
这类「想要单一 storage 句柄、又想透明跨多个根调度」的场景。

```ts
import { createStorageGateway } from '@aalis/plugin-storage-api';

const storage = createStorageGateway(ctx);
await storage.writeFile('data:/notes/x.md', 'hi'); // 路由到提供 data 根的后端
await storage.readFile('workspace:/a.txt');        // 路由到提供 workspace 根的后端
```

URI 即标识 + 路由 key，调用方无需关心哪个根由哪个后端提供。根不存在时抛
「未知存储根: X（已注册根: ...）」（`index.ts:329-333`）。

---

## 提供端（写一个存储后端时）

### 按根拆分 entry（per-root service granularity）

0.5.0 之后**没有 router facade**：每个根注册成一个独立的 ServiceContainer entry，约定 entryId 为
`${ctx.id}/${root.name}`（`plugin-storage-local/src/index.ts:688-691`）：

```ts
ctx.provide('storage', scopedStorageService, {
  entryId: `${ctx.id}/${root.name}`,        // per-root 粒度
  label: root.label || `本地根 ${root.name}`,
});
```

URI → 根 → entry 的路由由调用方的 `createStorageGateway(ctx)` 完成。后端只要：

- `listRoots()` 返回自己提供的根（含权限位）。
- 每个数据方法收到 URI 后，自己 parse 出相对路径并校验根名归属（参考实现 `parseSelfUri`，`index.ts:526-532`）。

### 权限位携带在 `StorageRootInfo` 上

根的真实权限由 `StorageRootInfo` 的 `readable` / `writable` / `deletable` 位携带（`index.ts:16-21`），
**不是**靠 DI 能力声明（0.5.0 的能力选择层已删除）。storage-api 的 `rootSatisfies`（`index.ts:220-243`）
按这些位 + `resolveLocalPath`/`watch` 方法存在性来判定根是否满足所需能力，gateway 据此路由。

---

## 「存储不是沙箱」边界

这是审计反复强调、也是最容易被插件作者误解的一点。明确写在接口注释里（`index.ts:73-86`、
`plugin-storage-local/src/index.ts:27-48`）：

- 存储层做三件事：**命名根**、**路径解析**（根内 `..` 穿越保护 + symlink realpath 校验）、**审计点**（读写删过 logger）。
- 路径校验只防**上层代码意外越界的 bug**（如 `workspace:/../../etc/passwd` 会被 `isInside` 拒掉，
  `plugin-storage-local/src/index.ts:540-546`），**不是用来对抗恶意子进程**。

`resolveLocalPath(uri, access)`（`index.ts:96-102`）把 URI 解析成宿主机绝对路径，交给必须用本地路径的
子进程（shell / code-runner）。**解析过程校验目标在声明的根内，但不会限制后续子进程的访问范围**：

```ts
// 这个绝对路径只是「工作目录/起点」，不是沙箱边界
const cwd = await storage.resolveLocalPath('workspace:/proj', 'read');
// 一旦 run_python / shell 拿到 cwd，子进程能访问当前 OS 用户可访问的任何文件
```

真正的隔离要靠 **OS 用户权限或容器**（参考 `code-sandbox-os`，也只是 OS 级 bwrap/seatbelt，非强隔离），
不能指望 storage 这一层。把 `resolveLocalPath` 的返回值当沙箱边界用，就是这类「困惑代理」（confused-deputy）漏洞的来源。

---

## 陷阱 / 边角案例（审计标注过的）

1. **别重抄正则**。`isStorageUri`/`parseUriRoot`/`toStorageUri` 是权威文法，全体消费者复用。
   自己写 `s.includes(':')` 之类判别会把 `data:image/...;base64,` 误判成 storage URI（漏了 `:/`），
   或把 `http://` 漏过保留 scheme 检查。

2. **`data:/` 与 base64 data-URI 的分流顺序**：先 `isStorageUri(data)`，**再** `data.startsWith('data:')`。
   反过来会把 `data:/...` 当成残缺 data-URI 处理。见 `plugin-media/src/service.ts:266-271`。

3. **单段裸名不当根名**。`toStorageUri('checkpoints')` → `data:/checkpoints`（data 根相对路径），
   不是 `checkpoints:/`。想让它当根名，得显式写 `checkpoints/` 带斜杠或 `checkpoints:/`。

4. **`parseUriRoot` 会抛**。对非 `<根名>:/...` 形态（`idx <= 0`）直接抛错（`index.ts:288`）；
   不确定输入时先 `isStorageUri` 守卫，或包 try/catch。

5. **未知根抛错**。gateway dispatch 找不到根名对应 entry 时抛「未知存储根」（`index.ts:329-333`）。
   `toStorageUri` 的单段裸名归到 `data` 根，正是为了避免把裸名当根名后必然命中这个错误。

6. **同名根冲突**：多个后端各自声明同名根时，gateway 按 entry 枚举顺序取首个，其余被遮蔽。
   用 `getStorageRootConflicts(ctx)`（`index.ts:195`）做 doctor / 启动日志诊断。

7. **`resolveLocalPath` / `watch` 可能不存在**：远程协议或纯虚拟根的后端可能不实现这两个可选方法
   （`index.ts:102`、`index.ts:111`）；gateway 会抛「不支持 local-path/watch」（`index.ts:359-369`）。
   调用前判存在性，别假定所有根都能落地到本地路径。

8. **路径分隔符**：URI 路径统一用 `/`；后端在归一时会把 `\\` 转成 `/`（`plugin-storage-local` 的 `toUri`，`index.ts:223-226`）。

---

## 交叉链接

- 服务用法、内置 5 根的语义与配置：**`docs/services/storage.md`**（forward-ref，存储服务详解）。
- DI 服务模型（同名多 provider 选优、per-entry 粒度、`getService`/`getAllServices`/`provide` 仅取 name）：
  `docs/core/service.md`。
- 鉴权（数字等级 + HITL 确认；deniedCapabilities 硬禁；与存储根权限位正交）：
  `docs/core/authority.md`、`docs/plugins/plugin-authority.md`。
- SSRF 守卫出网通道 `safeFetch`（`http(s)://` 分支去向）：`@aalis/util-network-guard`（forward-ref `docs/services/network-guard.md`）。
- OS 级沙箱（与「存储不是沙箱」对照）：`docs/plugins/plugin-code-sandbox-os.md`、`docs/plugins/plugin-tool-code-runner.md`。
- 消费侧示例：`docs/plugins/plugin-adapter-onebot.md`、`docs/plugins/plugin-file-reader.md`、`docs/plugins/plugin-persona.md`。

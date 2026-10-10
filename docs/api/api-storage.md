# api-storage — 统一文件/对象存储契约

**包名**: `@aalis/api-storage`  
**源码**: `packages/api-storage/src/index.ts`  
**实现**: `@aalis/plugin-storage-local`（一个提供者，内部按根路由）

## 概述

`StorageService` 把家目录里的若干目录（文件工具的工作根 workspace、插件数据用的 data / pluginData / tmp / cache / logs / personas / skills / workflows / paper / public，以及用户自定义根）映射成具名 storage URI（`name:/path`），上层用 URI 而非绝对路径访问文件。

定位：

1. **命名根** —— 统一抽象，禁止上层硬编码绝对路径
2. **路径解析** —— 规范化、`..` 穿越保护、symlink realpath 校验（防 bug，不防恶意）
3. **审计点** —— 所有读/写/删过 logger

**注意**：本服务**不是**沙箱。`resolveLocalPath()` 一旦把绝对路径交给 shell/code-runner 等子进程，进程能访问当前 OS 用户所有可达文件。真正的隔离依赖 OS 用户/容器。

## 关键类型

```ts
interface StorageRootInfo {
  name: string;
  label?: string;
  kind: 'workspace' | 'data' | 'tmp' | 'pluginData' | 'logs' | string;
  browsable: boolean;
  readable: boolean;
  writable: boolean;
  deletable: boolean;
}

interface StorageEntry { name; path; uri; isDirectory; size; mtime; ext; }
interface StorageStat  { ...StorageEntry; birthtime; }
interface StorageListResult { root: StorageRootInfo; path: string; entries: StorageEntry[]; }
interface StorageReadStreamResult { stream: Readable; stat: StorageStat; }
interface StorageWatchEvent { type: 'change'; uri: string; path: string; }
type StorageWatchListener = (event: StorageWatchEvent) => void;
type StorageUnwatch = () => void;
```

## 服务接口

```ts
interface StorageService {
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

目标不存在时，`readFile` 等按路径定位的方法抛出带 `code: 'ENOENT'` 的错误，其它失败不用这个 code；消费方用 `isStorageNotFound(err)` 区分「不存在」与「读不出」。`writeFile` 的 `options.secret` 表示内容是凭据（访问 token 一类），只给运行 Aalis 的系统用户读写：参考实现以 0600 建文件，覆写已有文件时一并收紧，内容从不以更宽的权限落盘；做不到的提供者应拒写，不得照常写成别人读得到的文件。`readFileRange` 按字节区间 `[start, end)` 读取，供大文件窗口化访问；提供者未实现时业务层的 `readFileRange` 抛错，调用方回退 `readFile`（`readTailLines` 已内置该回退）。`watch` 监听文件或目录（目录递归）的变化，返回取消函数；事件可能经过去抖，远程或虚拟根可能不支持。参考实现的监听器随提供者关闭而结束，需要持续监听的消费者用 `caps.storage.follow` 在新提供者上重挂。

## 业务层

描述符 `storage` 有自定义绑定，业务层是 `BoundStorage`：调用转发给本插件选中的存储提供者，由提供者按 URI 的根名分给对应的根。

```ts
type StorageMethods = StorageService & Required<Pick<StorageService, 'resolveLocalPath' | 'readFileRange' | 'watch'>>;

type OwnStorage = Omit<StorageMethods, 'listRoots'> & {
  uri(path?: string): string;
};

interface BoundStorage extends StorageMethods {
  readonly own: OwnStorage;
}
```

- `resolveLocalPath` / `readFileRange` / `watch` 在业务层上恒定义：选中的那一家不支持时，调用本身抛「存储提供者不支持 X」，调用方不必先判方法是否存在。
- `own` 是本插件私有目录 `pluginData:/<目录名>/` 上的存储视图。目录名是包名去掉 `plugin-` 前缀：`@aalis` 与不带作用域的包只取包名（`@aalis/plugin-paper` → `paper`），别的作用域另带作用域、以 `+` 相连（`@acme/plugin-paper` → `acme+paper`；npm 包名里没有 `+`，两个作用域的同名插件不共用目录）。取不出单段目录名的插件名（空、`.` 或 `..`、含斜杠或反斜杠）在绑定时抛错，插件激活失败。同一插件的多个实例共用这个目录，需要区分时由插件自己分子目录。方法与 `StorageService` 相同（没有 `listRoots`），路径参数相对这个目录：规范化之后越出目录的（`..` 越过目录）、宿主机绝对路径与存储地址都抛错，空路径即目录本身（`own.delete('')` 删掉整个私有目录）；返回值里的地址是完整的存储地址。`own.uri(path)` 给出相对路径对应的完整存储地址，不给参数即目录本身。

```ts
import { storage } from '@aalis/api-storage';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-storage',
  uses: { storage },
  apply({ storage }) {
    void storage.use.readFile('data:/example.json', 'utf8');
    void storage.use.own.writeFile('state.json', '{}'); // pluginData:/example-storage/state.json
  },
});
```

业务句柄是活的，可以长期持有：每次调用都转发给此刻选中的那一家。不要把 `services.use.get(storage)` 拿到的原始实例存进字段当「当前后端」。

## URI 规范

- `workspace:/path/to/file` —— 项目工作区（用户文件）
- `data:/scheduler-jobs.json` —— Aalis 数据
- `tmp:/code-runner/...` —— 临时区
- `pluginData:/my-plugin/state.json` —— 插件私有
- `host:/` —— 宿主机绝对路径（仅在 storage 配置显式开启时存在，**默认关闭**）

文件工具与各后端消费者复用的统一 `toStorageUri()` 实现在本包 `packages/api-storage/src/index.ts`（契约级文法，勿各自重抄）。

## 权限

每个 storage 根自带 `readable` / `writable` / `deletable` 读写删开关；提供者在每个操作前按这些位核对，不允许时抛错（参考实现为「存储根 X 不允许该操作 (writable)」一类）。`resolveLocalPath(uri, access)` 在解析时按 `access` 校验对应根是否允许该操作，越权即抛错。

## 实现者

- `@aalis/plugin-storage-local` — 本地文件系统；`apply` 里先建好全部根（`roots[]` 里的用户根与按家目录布局派生的内部根），再整体登记一个提供者 `provide.use(storage, new LocalStorage(scoped), { label })`。根在它内部按 URI 根名路由，根名不认识时抛「未知存储根: x（已注册根: …）」。

## Helper

纯函数，不吃服务：

- `isStorageUri` / `parseUriRoot` / `toStorageUri` / `parseStorageUri` / `resolveAgainstCwd` — 契约级路径文法
- `isHostAbsolutePath(input)` — 宿主机绝对路径（`/abs`、`C:\path`、`C:/path`）判据：不是存储地址，`toStorageUri` 抛配置错误、`resolveAgainstCwd` 拒绝
- `isStorageNotFound(err)` — 「目标不存在」判据：有 `code` 时只认 `ENOENT`，没有 `code` 才看错误文案
- `canIssueFileHandle(roots, uri)` — 能不能给这个存储地址签发界面下载用的句柄：是存储地址、根在 `roots` 里，且根的种类不是 `data`（映射到家目录的 `state/`，里面有 WebUI 的 token 与审计）或 `pluginData`。按根的种类判、不按路径。会话条目的文件句柄（plugin-session-server）与页面单元格的文件句柄（plugin-webui-server）共用这一条

## 相关

- 路径安全：本包 `toStorageUri()` / `parseStorageUri()` / `resolveAgainstCwd()`

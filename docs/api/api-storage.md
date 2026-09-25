# api-storage — 统一文件/对象存储契约

**包名**: `@aalis/api-storage`  
**源码**: `packages/api-storage/src/index.ts`  
**实现**: `@aalis/plugin-storage-local`（按根多实例注册）

## 概述

`StorageService` 把项目里几个目录（workspace / data / tmp / pluginData / logs，以及用户自定义根）映射成具名 storage URI（`name:/path`），上层用 URI 而非绝对路径访问文件。

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
```

## 服务接口

```ts
interface StorageService {
  listRoots(): StorageRootInfo[];
  list(uri: string): Promise<StorageListResult>;
  stat(uri: string): Promise<StorageStat>;
  readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  createReadStream(uri: string): Promise<StorageReadStreamResult>;
  writeFile(uri: string, data: string | Buffer): Promise<void>;
  rename(uri: string, newName: string): Promise<string>;
  move(fromUri: string, toUri: string): Promise<string>;
  mkdir(uri: string): Promise<string>;
  delete(uri: string): Promise<void>;
  resolveLocalPath?(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string>;
}
```

描述符 `storage` 是普通调用型：绑定接口是 `ServiceRef<StorageService>`。每个 entry 只负责一个根，以 `entryId = '${激活id}/${rootName}'` 名义 `provide`。上层跨 root 调度用 `createStorageGateway(storage)`（第一参是 `ServiceRef`，不是激活记录）。gateway **不**注册进容器。

```ts
import { createStorageGateway, storage } from '@aalis/api-storage';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-storage',
  uses: { storage },
  apply({ storage }) {
    const gateway = createStorageGateway(storage);
    void gateway.readFile('data:/example.json', 'utf8');
  },
});
```

网关每次方法调用按 URI 重新枚举 `storage.all()` 并路由。构造一次网关对象可以长期持有——它不缓存某个 root 的 `StorageService` 实例。不要把 `storage.current` 或 `storage.all()[i]` 存进字段当「当前后端」。

## Capability 框架

```
list          .list() + .listRoots()
read          .readFile() / .createReadStream()
write         .writeFile() / .rename()
delete        .delete()
local-path    .resolveLocalPath() —— shell/code-runner 必需
```

这些是按 root 权限位 + 方法是否存在做过滤，不是 DI 能力声明。

## URI 规范

- `workspace:/path/to/file` —— 项目工作区（用户文件）
- `data:/scheduler-jobs.json` —— Aalis 数据
- `tmp:/code-runner/...` —— 临时区
- `pluginData:/my-plugin/state.json` —— 插件私有
- `host:/` —— 宿主机绝对路径（仅在 storage 配置显式开启时存在，**默认关闭**）

文件工具与各后端消费者复用的统一 `toStorageUri()` 实现在本包 `packages/api-storage/src/index.ts`（契约级文法，勿各自重抄）。

## 权限

每个 storage 根自带 `readable` / `writable` / `deletable` 读写删开关；`resolveLocalPath(uri, access)` 在解析时按 `access` 校验对应根是否允许该操作，越权即抛错。

## 实现者

- `@aalis/plugin-storage-local` — 本地文件系统；`apply` 里为每个 `roots[]` 条目独立 `provide(storage, scoped, { entryId, label })`。

## Helper

第一参均为 `ServiceRef<StorageService>`：

- `getStorageEntries(source)` — 全部注册过的 storage entry
- `aggregateStorageRoots(source)` / `getStorageRootConflicts(source)` — 跨 entry 汇总根、识别同名冲突
- `resolveStorageEntryForRoot(source, rootName, requiredCaps?)` / `resolveStorageByPath(source, uri, requiredCaps?)` — 按 root 名或 URI 查负责该路径的 entry
- `createStorageGateway(source)` — 调用点按 URI 路由的临时 `StorageService`
- `isStorageUri` / `parseUriRoot` / `toStorageUri` / `parseStorageUri` / `resolveAgainstCwd` — 契约级路径文法

## 相关

- 路径安全：本包 `toStorageUri()` / `parseStorageUri()` / `resolveAgainstCwd()`

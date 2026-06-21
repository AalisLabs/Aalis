# plugin-storage-api — 统一文件/对象存储契约

**包名**: `@aalis/plugin-storage-api`  
**源码**: `packages/plugin-storage-api/src/index.ts`  
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
  name: string;                                            // 'workspace' / 'data' / 自定义
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
  delete(uri: string): Promise<void>;
  resolveLocalPath?(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string>;
}
```

## Capability 框架

```
list          .list() + .listRoots()
read          .readFile() / .createReadStream()
write         .writeFile() / .rename()
delete        .delete()
local-path    .resolveLocalPath() —— shell/code-runner 必需
```

每个 `storage` entry 只负责一个根 (root)，以 `entryId = '<plugin-id>/<rootName>'` 名义注册。上层如需跨多个 root 调度，使用 `createStorageGateway(ctx)` 拿一个在调用点按 URI 路由的 `StorageService`（该 gateway **不**注册进容器，避免出现同名 facade entry）。
```

依赖声明：

```ts
export const inject = {
  required: [{ service: 'storage', capabilities: ['read', 'write'] }],
  optional: [{ service: 'storage', capabilities: ['local-path'] }],
};
```

## URI 规范

- `workspace:/path/to/file` —— 项目工作区（用户文件）
- `data:/scheduler-jobs.json` —— Aalis 数据
- `tmp:/code-runner/...` —— 临时区
- `pluginData:/my-plugin/state.json` —— 插件私有
- `host:/` —— 宿主机绝对路径（仅在 storage 配置显式开启时存在，**默认关闭**）

文件工具与 SSRF 校验的统一 `toStorageUri()` 实现在 [plugin-tools-api](./plugin-tools-api.md) 的 `utils`。

## 权限

每个 storage 根自带 `readable` / `writable` / `deletable` 读写删开关；`resolveLocalPath(uri, access)` 在解析时按 `access` 校验对应根是否允许该操作，越权即抛错。访问哪些根由 `provide('storage', …, { capabilities })` 时声明的能力决定。

## 实现者

- [@aalis/plugin-storage-local](../plugins/plugin-storage-local.md) — 本地文件系统；`apply()` 里为每个 `roots[]` 条目独立 `ctx.provide('storage', ScopedStorageService, { entryId, capabilities })`。

## Helper

- `getStorageEntries(ctx, requiredCaps?)` — 拿到全部注册过的 storage entry。
- `aggregateStorageRoots(ctx)` / `getStorageRootConflicts(ctx)` — 跨 entry 汇总根、识别同名冲突。
- `resolveStorageEntryForRoot(ctx, rootName, requiredCaps?)` / `resolveStorageByPath(ctx, uri, requiredCaps?)` — 按 root 名或 URI 查到负责该路径的 entry。
- `createStorageGateway(ctx)` — 返回一个在调用点路由 URI 、职责该 entry 的临时 `StorageService`；适用于文件工具、code-runner 、checkpoint 、webui-server 等需要统一入口的使用者。

## 相关

- 路径安全：[plugin-tools-api](./plugin-tools-api.md) 的 `toStorageUri()`

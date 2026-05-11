# plugin-storage-api — 统一文件/对象存储契约

**包名**: `@aalis/plugin-storage-api`  
**源码**: `packages/plugin-storage-api/src/index.ts`  
**实现**: `@aalis/plugin-storage-local`, `@aalis/plugin-storage-router`

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
router        多 storage 实例聚合（plugin-storage-router）
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

通常通过 `permissions: ['storage:<rootName>:<read|write|delete>']` 声明，由 `ExecutionGuard` 在执行前判定。

## 实现者

- [@aalis/plugin-storage-local](../plugins/plugin-storage-local.md) — 本地文件系统
- [@aalis/plugin-storage-router](../plugins/plugin-storage-router.md) — 多 storage 聚合

## 相关

- 路径安全：[plugin-tools-api](./plugin-tools-api.md) 的 `toStorageUri()`

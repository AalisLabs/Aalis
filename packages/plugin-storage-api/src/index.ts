// ----- 存储服务接口 -----

import type { Readable } from 'node:stream';

export type StorageRootKind = 'workspace' | 'data' | 'tmp' | 'pluginData' | 'logs' | string;

export interface StorageRootInfo {
  /** 根 ID，如 workspace、data、tmp */
  name: string;
  /** 展示名称 */
  label?: string;
  /** 语义类型，用于权限 UI 和策略判断 */
  kind: StorageRootKind;
  /** 是否允许通过通用文件浏览 UI 展示 */
  browsable: boolean;
  /** 默认是否允许读 */
  readable: boolean;
  /** 默认是否允许写 */
  writable: boolean;
  /** 默认是否允许删除 */
  deletable: boolean;
}

export interface StorageEntry {
  name: string;
  path: string;
  uri: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  ext: string;
}

export interface StorageStat {
  name: string;
  path: string;
  uri: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  birthtime: string;
  ext: string;
}

export interface StorageListResult {
  root: StorageRootInfo;
  path: string;
  entries: StorageEntry[];
}

export interface StorageReadStreamResult {
  stream: Readable;
  stat: StorageStat;
}

/**
 * StorageService 的职责定位：
 *
 * 1) **命名根**：把项目里的几个目录起一个稳定名字（workspace / data / tmp /
 *    pluginData / logs，以及用户自定义根），让上层用 URI（`name:/path`）表示文件，
 *    而不是把绝对路径硬编码到配置或工具调用里。
 * 2) **路径解析**：对 storage URI 做规范化、根内 `..` 穿越保护、symlink realpath 校验。
 *    这是为防止上层代码意外越界（防 bug），不是用来对抗恶意子进程。
 * 3) **审计点**：所有读/写/删都经过 logger，便于事后排查。
 *
 * 它**不是**沙箱：`resolveLocalPath` 一旦把绝对路径交给 `run_python`、shell 等子进程，
 * 子进程可以访问当前 OS 用户能访问的任何文件。真正的隔离应该靠 OS 用户权限或容器，
 * 不应该指望这一层。
 */
export interface StorageService {
  listRoots(): StorageRootInfo[];
  list(uri: string): Promise<StorageListResult>;
  stat(uri: string): Promise<StorageStat>;
  readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  createReadStream(uri: string): Promise<StorageReadStreamResult>;
  writeFile(uri: string, data: string | Buffer): Promise<void>;
  rename(uri: string, newName: string): Promise<string>;
  delete(uri: string): Promise<void>;
  /**
   * 把 storage URI 解析为本机绝对路径，给必须使用本地路径的子进程（shell、code-runner）用。
   *
   * 注意：解析过程会校验目标位于声明的根内，但**不会限制后续子进程的访问范围**。
   * 调用方必须自觉只把这条路径用作"工作目录/起点"，不要把它当成沙箱边界。
   */
  resolveLocalPath?(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string>;
}

// ----- 存储能力声明 -----

export interface StorageCapabilityRegistry {
  List: 'list';
  Read: 'read';
  Write: 'write';
  Delete: 'delete';
  LocalPath: 'local-path';
  Router: 'router';
}

export type StorageCapability = StorageCapabilityRegistry[keyof StorageCapabilityRegistry];

export const StorageCapabilities = {
  List: 'list',
  Read: 'read',
  Write: 'write',
  Delete: 'delete',
  LocalPath: 'local-path',
  Router: 'router',
} as const satisfies StorageCapabilityRegistry;

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    storage: StorageCapability;
  }
}

import { registerCapabilityProbe } from '@aalis/core';

registerCapabilityProbe('storage', StorageCapabilities.List, inst =>
  typeof (inst as { list?: unknown }).list === 'function'
    && typeof (inst as { listRoots?: unknown }).listRoots === 'function'
    ? true
    : 'StorageService.listRoots()/list() are required for capability "list"');

registerCapabilityProbe('storage', StorageCapabilities.Read, inst =>
  typeof (inst as { readFile?: unknown }).readFile === 'function'
    && typeof (inst as { createReadStream?: unknown }).createReadStream === 'function'
    ? true
    : 'StorageService.readFile()/createReadStream() are required for capability "read"');

registerCapabilityProbe('storage', StorageCapabilities.Write, inst =>
  typeof (inst as { writeFile?: unknown }).writeFile === 'function'
    && typeof (inst as { rename?: unknown }).rename === 'function'
    ? true
    : 'StorageService.writeFile()/rename() are required for capability "write"');

registerCapabilityProbe('storage', StorageCapabilities.Delete, inst =>
  typeof (inst as { delete?: unknown }).delete === 'function'
    ? true
    : 'StorageService.delete() is required for capability "delete"');

registerCapabilityProbe('storage', StorageCapabilities.LocalPath, inst =>
  typeof (inst as { resolveLocalPath?: unknown }).resolveLocalPath === 'function'
    ? true
    : 'StorageService.resolveLocalPath() is required for capability "local-path"');
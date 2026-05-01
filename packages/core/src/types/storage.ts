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

export interface StorageService {
  listRoots(): StorageRootInfo[];
  list(uri: string): Promise<StorageListResult>;
  stat(uri: string): Promise<StorageStat>;
  readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  createReadStream(uri: string): Promise<StorageReadStreamResult>;
  writeFile(uri: string, data: string | Buffer): Promise<void>;
  rename(uri: string, newName: string): Promise<string>;
  delete(uri: string): Promise<void>;
}

// ----- 存储能力声明 -----

export interface StorageCapabilityRegistry {
  List: 'list';
  Read: 'read';
  Write: 'write';
  Delete: 'delete';
}

export type StorageCapability = StorageCapabilityRegistry[keyof StorageCapabilityRegistry];

export const StorageCapabilities = {
  List: 'list',
  Read: 'read',
  Write: 'write',
  Delete: 'delete',
} as const satisfies StorageCapabilityRegistry;

declare module './capabilities.js' {
  interface ServiceCapabilityMap {
    storage: StorageCapability;
  }
}

import { registerCapabilityProbe } from './capabilities.js';

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
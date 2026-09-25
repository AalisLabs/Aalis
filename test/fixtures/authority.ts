import type { HostConfig } from '../../packages/api-host-config/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';

// AuthorityManager 单测的三件套：内存配置、静默日志、无文件存储。

/** 内存 HostConfig：以 cfg 为初值，set 只改内存 */
export function mkConfig(cfg: Record<string, unknown> = {}): HostConfig {
  const store: Record<string, unknown> = { ...cfg };
  return {
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => {
      store[k] = v;
    },
  } as unknown as HostConfig;
}

export function silentLogger(): Logger {
  const l = { child: () => l, debug() {}, info() {}, warn() {}, error() {} };
  return l as unknown as Logger;
}

/** 无文件存储（load 抛错→空表；save no-op）。测试用 setUserLevel 直接喂内存。 */
export const noFileStorage = {
  readFile: async () => {
    throw new Error('no file');
  },
  writeFile: async () => {},
} as unknown as StorageService;

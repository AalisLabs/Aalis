import type { HostConfig } from '../../packages/api-host-config/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';

// AuthorityManager 单测的四件套：内存配置、静默日志、无文件存储、空会话表。

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

/** 无文件存储（load 按文件不存在→空表；save no-op）。测试用 setUserLevel 直接喂内存。 */
export const noFileStorage = {
  readFile: async () => {
    throw Object.assign(new Error('no file'), { code: 'ENOENT' });
  },
  writeFile: async () => {},
} as unknown as StorageService;

/** 空会话表：会话管理不在，发起类别按受众判不出处理 */
export const noSessions = () => undefined;

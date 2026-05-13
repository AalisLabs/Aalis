/**
 * 平台检测与适配器接口（运行时）
 *
 * 类型已迁出到 `./platform-types.ts` 以打破 platform ↔ adapters/* 的循环图。
 * 本文件仅保留：
 *  - 类型 re-export（保留 `import { ... } from './platform.js'` 旧引用兼容性）
 *  - `detectPlatform()` / `createAdapter()` 等需要 `node:os` + 动态 import 的运行时
 */

import { platform } from 'node:os';
import type { PlatformAdapter, PlatformType } from './platform-types.js';

// 类型 re-export，让 tools/* 等老消费者无需改动
export type {
  MouseButton,
  PlatformAdapter,
  PlatformType,
  Point,
  Region,
  ScreenInfo,
  WindowInfo,
} from './platform-types.js';

// ──────────── 平台检测 ────────────

export function detectPlatform(): PlatformType {
  switch (platform()) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
}

export async function createAdapter(): Promise<PlatformAdapter> {
  const p = detectPlatform();
  switch (p) {
    case 'macos': {
      const { MacOSAdapter } = await import('./adapters/macos.js');
      return new MacOSAdapter();
    }
    case 'linux': {
      const { LinuxAdapter } = await import('./adapters/linux.js');
      return new LinuxAdapter();
    }
    case 'windows': {
      const { WindowsAdapter } = await import('./adapters/windows.js');
      return new WindowsAdapter();
    }
  }
}

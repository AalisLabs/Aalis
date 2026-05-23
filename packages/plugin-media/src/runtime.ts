// ============================================================
// runtime.ts — plugin-media 的模块级运行时依赖注入
//
// ffmpeg.ts / safe-fetch.ts 中的工具函数都需要 ProcessService + StorageService
// 才能跑子进程 + 拿临时目录，又被 service.ts / tools.ts 当作纯函数引用。
// 用一个 setRuntime() 在 apply() 时注入，避免改动所有调用点。
// ============================================================

import type { ProcessService } from '@aalis/plugin-process-api';
import type { StorageService } from '@aalis/plugin-storage-api';

interface MediaRuntime {
  proc: ProcessService;
  storage: StorageService;
}

let current: MediaRuntime | null = null;

export function setMediaRuntime(rt: MediaRuntime): void {
  current = rt;
}

export function getMediaRuntime(): MediaRuntime {
  if (!current) {
    throw new Error(
      'plugin-media 运行时未初始化（请确认 @aalis/plugin-process-local 与 @aalis/plugin-storage-local 已启用）',
    );
  }
  return current;
}

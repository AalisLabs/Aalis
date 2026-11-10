// ============================================================
// runtime.ts — plugin-media 的模块级运行时依赖注入
//
// cache、ffmpeg、llm-adapter、service、tools 里的函数要用 ProcessService 与 StorageService（跑子进程、拿临时目录、
// 读写存储），又以模块函数的形式互相调用：apply 时经 setMediaRuntime 注入一次，不必逐层传参。
// 两项服务都是 required，插件里调用到这些函数都在 apply 注入之后。
// ============================================================

import type { ProcessService } from '@aalis/api-process';
import type { StorageService } from '@aalis/api-storage';

interface MediaRuntime {
  proc: ProcessService;
  storage: StorageService;
}

let current: MediaRuntime;

export function setMediaRuntime(rt: MediaRuntime): void {
  current = rt;
}

export function getMediaRuntime(): MediaRuntime {
  return current;
}

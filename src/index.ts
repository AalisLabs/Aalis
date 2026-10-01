import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsPluginLoader, startAalis } from '@aalis/runtime';

// monorepo 自托管入口：安装集是仓库根，扫 packages/ 加载插件；家目录由命令行或环境变量决定
// （`pnpm dev` 传 `--home .aalis-dev`，从源码运行的生产实例用 AALIS_HOME 或缺省的 ~/.aalis）。
// 子命令分发、控制台/文件日志、终端复原走 startAalis 默认。宿主实现全在 @aalis/runtime。
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
startAalis({ appDir, pluginLoader: createFsPluginLoader(join(appDir, 'packages')) }).catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsPluginLoader, startAalis } from '@aalis/runtime';

// monorepo 自托管入口：安装集是仓库根，扫 packages/ 加载插件；数据目录缺省是仓库下的 data/，带 --profile <名> 时是
// data-<名>/，--data 或 AALIS_DATA 可换到别处。
// 子命令分发、控制台/文件日志走 startAalis 默认。宿主实现全在 @aalis/runtime。
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
startAalis({ appDir, pluginLoader: createFsPluginLoader(join(appDir, 'packages')) }).catch(err => {
  console.error('Aalis failed to start:', err);
  process.exit(1);
});

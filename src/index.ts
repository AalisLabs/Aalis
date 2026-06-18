import { createFsPluginLoader, startAalis } from '@aalis/runtime';

// monorepo 自托管入口：扫 packages/ 加载插件 + 开启 `aalis <cmd>` 子命令分发；
// 控制台/文件日志、终端复原走 startAalis 默认（开）。宿主实现全在 @aalis/runtime。
startAalis({ pluginLoader: createFsPluginLoader(), subcommands: true }).catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});

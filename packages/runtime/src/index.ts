// @aalis/runtime —— Aalis 默认 Node 宿主层（独立部署与 monorepo 自托管共用）
//
// 两种部署模型的加载器 + YAML 配置/重启策略 + 一行启动 startAalis，以及可移植宿主件
// （日志 sink / 终端复原 / 子命令分发）。core 只产生 LogEntry，染色/TTY/文件落盘全在本层。
//   - createNodeModulesPluginLoader：纯 npm 独立部署（从 node_modules 解析插件）
//   - createFsPluginLoader：monorepo 自托管（扫描 packages/ 目录）
//   - createFsYamlConfigProvider / createProcessRespawnStrategy：YAML 配置 + 进程级重启
//   - startAalis：组装以上 + 宿主件为实例并启动（带 options 开关，默认独立部署）
//   - install*/setup*/tryDispatchSubcommand：宿主件，供高级 opt-in 组装

export { getBootstrapBuffer, installBootstrapBuffer } from './bootstrap-buffer.js';
export { type ConsoleSinkHandle, installConsoleSink } from './console-sink.js';
export { appendCrashLog, DEFAULT_LOG_FILE, type FileLoggerHandle, setupFileLogger } from './file-logger.js';
export { createNodeModulesPluginLoader } from './node-modules-loader.js';
export { createFsPluginLoader, createFsYamlConfigProvider, createProcessRespawnStrategy } from './providers.js';
export { type StartAalisOptions, startAalis } from './start.js';
export { tryDispatchSubcommand } from './subcommand.js';
export { installTerminalStateRestorer, restoreTerminalState } from './terminal.js';

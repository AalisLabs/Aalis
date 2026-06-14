// @aalis/runtime —— Aalis 独立部署运行时（node 宿主层）
//
// 提供两种部署模型的加载器与 YAML 配置/重启策略，以及一行启动 startAalis：
//   - createNodeModulesPluginLoader：纯 npm 独立部署（从 node_modules 解析插件）
//   - createFsPluginLoader：monorepo 自托管（扫描 packages/ 目录）
//   - createFsYamlConfigProvider / createProcessRespawnStrategy：YAML 配置 + 进程级重启
//   - startAalis：组装以上为独立实例并启动
//
// monorepo 的 src/runtime/providers.ts 从本包再导出 FS 系列，单一事实来源、零重复。

export { createNodeModulesPluginLoader } from './node-modules-loader.js';
export {
  createFsPluginLoader,
  createFsYamlConfigProvider,
  createProcessRespawnStrategy,
} from './providers.js';
export { type StartAalisOptions, startAalis } from './start.js';

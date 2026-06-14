// 宿主层 node providers 已抽取到发布包 @aalis/runtime（单一事实来源，供独立部署与
// monorepo 自托管共用）。本文件仅为 monorepo 入口 src/index.ts 与测试 fixture 保留
// 原导入路径，从 @aalis/runtime 再导出 FS 系列（扫描 packages/ 的部署模型）。
//
// 独立部署（纯 npm）用 createNodeModulesPluginLoader / startAalis，见 @aalis/runtime。

export {
  createFsPluginLoader,
  createFsYamlConfigProvider,
  createProcessRespawnStrategy,
} from '@aalis/runtime';

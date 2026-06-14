import { App } from '@aalis/core';
import { createNodeModulesPluginLoader } from './node-modules-loader.js';
import { createFsYamlConfigProvider, createProcessRespawnStrategy } from './providers.js';

// ============================================================
// startAalis —— 独立部署一行启动
// ============================================================
//
// 纯 npm 装 Aalis 的入口：scaffold 生成的 index.mjs 只需
//   import { startAalis } from '@aalis/runtime';
//   startAalis();
// 即从 aalis.config.yaml 读配置、从 node_modules 加载已装插件、启动并挂优雅退出。

export interface StartAalisOptions {
  /** aalis.config.yaml 路径，默认 cwd 下的 aalis.config.yaml */
  configPath?: string;
  /** 项目根目录（含 package.json + node_modules），默认 process.cwd() */
  projectDir?: string;
  /** 应用层声明的必需服务（缺失则启动告警），默认空 */
  requiredServices?: string[];
}

/**
 * 启动一个独立部署的 Aalis 实例：YAML 配置 + node_modules 插件加载 + 进程级重启。
 * 返回已启动的 App（便于测试或进一步操作）。
 */
export async function startAalis(opts: StartAalisOptions = {}): Promise<App> {
  const { config, provider, dataDir } = createFsYamlConfigProvider(opts.configPath);

  const app = new App({
    config,
    configProvider: provider,
    dataDir,
    pluginLoader: createNodeModulesPluginLoader(opts.projectDir),
    restartStrategy: createProcessRespawnStrategy(),
    // 宿主层决定 dev/prod；core 不读 process.env
    devMode: process.env.NODE_ENV !== 'production',
    requiredServices: opts.requiredServices ?? [],
  });

  await app.autoLoadPlugins();
  await app.start();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}

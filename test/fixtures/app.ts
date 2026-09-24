import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import { App, type AppOptions, type LogLevel } from '../../packages/core/src/index.js';
import {
  type ConfigProvider,
  type ConfigStore,
  createConfigStore,
  installHostConfig,
} from '../../packages/runtime/src/config-store.js';
import { createFsPluginLoader, createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';

/**
 * 测试用配置构造工具：
 *
 * - `inMemoryConfig(yaml)` —— 直接把 YAML 文本解析为 `AalisConfig`，
 *   完全不碰文件系统，适合不需要 save/watch 的纯逻辑测试。
 * - `tempConfig(yaml)` —— 写一个临时 yaml 文件并返回配置快照、provider 与清理句柄，
 *   适合需要 `config.save()` 写回 yaml 或扫描 packages 的集成测试。
 */

export function inMemoryConfig(yaml: string): AalisConfig {
  return (parseYaml(yaml) ?? {}) as AalisConfig;
}

export interface TempConfigHandle {
  dir: string;
  path: string;
  config: AalisConfig;
  provider: ReturnType<typeof createFsYamlConfigProvider>['provider'];
  pluginLoader: ReturnType<typeof createFsPluginLoader>;
  cleanup: () => void;
}

export function tempConfig(yaml: string): TempConfigHandle {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-app-'));
  const path = join(dir, 'aalis.config.yaml');
  writeFileSync(path, yaml);
  const { config, provider } = createFsYamlConfigProvider(path);
  return {
    dir,
    path,
    config,
    provider,
    pluginLoader: createFsPluginLoader(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 带配置文档的 App：与 startAalis 同一装配（文档 → App → installHostConfig），供要用 host-config 的测试。
 * 文档缺省为 `{ name: 'T', logLevel: 'error', plugins: {} }`；`provider` 接落盘与外部变更。
 * 登记插件时 core 不再读文档：要按文档登记，用 {@link registerFromDoc}。
 */
export function hostedApp(
  doc: Partial<AalisConfig> = {},
  options: Omit<AppOptions, 'name' | 'logLevel'> & { provider?: ConfigProvider } = {},
): { app: App; store: ConfigStore } {
  const { provider, ...appOptions } = options;
  const store = createConfigStore({ name: 'T', logLevel: 'error', plugins: {}, ...doc }, provider);
  const app = new App({ name: store.get('name'), logLevel: store.get('logLevel') as LogLevel, ...appOptions });
  installHostConfig(app, store);
  return { app, store };
}

/** 按文档登记：配置与禁用标记取自文档，与 runtime 发现驱动的登记口径相同 */
export function registerFromDoc(
  app: App,
  store: ConfigStore,
  definition: Parameters<App['plugin']>[0],
  instanceId = definition.name,
): Promise<boolean> {
  return app.plugin(definition, store.getPluginConfig(instanceId), instanceId, {
    disabled: store.isPluginDisabled(instanceId),
  });
}

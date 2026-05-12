import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AalisConfig } from '../../packages/core/src/index.js';
import { createFsPluginLoader, createFsYamlConfigProvider } from '../../src/runtime/providers.js';

/**
 * 测试用配置构造工具：
 *
 * - `inMemoryConfig(yaml)` —— 直接把 YAML 文本解析为 `AalisConfig`，
 *   完全不碰文件系统，适合不需要 save/watch 的纯逻辑测试。
 * - `tempConfig(yaml)` —— 写一个临时 yaml 文件并返回 `{ path, cleanup, provider, config, dataDir }`，
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
  dataDir: string;
  pluginLoader: ReturnType<typeof createFsPluginLoader>;
  cleanup: () => void;
}

export function tempConfig(yaml: string): TempConfigHandle {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-app-'));
  const path = join(dir, 'aalis.config.yaml');
  writeFileSync(path, yaml);
  const { config, provider, dataDir } = createFsYamlConfigProvider(path);
  return {
    dir,
    path,
    config,
    provider,
    dataDir,
    pluginLoader: createFsPluginLoader(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

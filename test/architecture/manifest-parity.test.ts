import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  config,
  contributions,
  events,
  hooks,
  lifecycle,
  logger,
  provide,
  services,
} from '../../packages/core/src/composition/core-services.js';
import { optionalNames, requiredNames, type Uses } from '../../packages/core/src/composition/descriptors.js';
import type { PluginDefinition } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// manifest 双源对账：package.json 的 aalis.service 与插件 default
// 导出的定义对象必须一致——前者喂市场展示与依赖预检，后者是运行时
// 真相。手工双源无对账即会漂移（漂移=元数据说谎，下游按谎言行动）。
//
// 对账源是 definePlugin 的产物：provides 取描述符 .name；uses 经
// core 自己的 requiredNames / optionalNames 展开（optional() 包装
// 也走同一套归一化，不在测试里猜结构）。
// ════════════════════════════════════════════════════════════

const PACKAGES = join(__dirname, '../../packages');

/**
 * 核心默认服务与 builtins.ts 导出的描述符集合对齐，和第三方共同参与依赖声明。
 * 增删内置能力必须同步更新本清单。host-config / app / plugins 是
 * 宿主管理面的普通服务，不在此列。
 */
const CORE_SERVICE_NAMES = [
  'config',
  'contributions',
  'events',
  'hooks',
  'lifecycle',
  'logger',
  'provide',
  'services',
] as const;

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...list].map(String).sort();
}

function isDefinition(value: unknown): value is PluginDefinition {
  return typeof value === 'object' && value !== null && typeof (value as PluginDefinition).apply === 'function';
}

describe('manifest 双源对账', () => {
  it('核心服务均进入与第三方相同的 required / optional 提取', () => {
    const fromModule = [config, contributions, events, hooks, lifecycle, logger, provide, services]
      .map(d => d.name)
      .sort();
    expect([...CORE_SERVICE_NAMES].sort()).toEqual(fromModule);
    expect(
      requiredNames({ config, contributions, events, hooks, lifecycle, logger, provide, services }).sort(),
    ).toEqual(fromModule);
  });

  it('全部 aalis-plugin 包的 aalis.service 与 default 定义的 provides/uses 一致', async () => {
    const drifts: string[] = [];
    let audited = 0;
    for (const pkg of readdirSync(PACKAGES)) {
      const pkgJsonPath = join(PACKAGES, pkg, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      const meta = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
        keywords?: string[];
        aalis?: { service?: { provides?: string[]; required?: string[]; optional?: string[] } };
      };
      if (!meta.keywords?.includes('aalis-plugin')) continue;
      const entry = join(PACKAGES, pkg, 'src/index.ts');
      if (!existsSync(entry)) continue;
      audited++;
      let ns: { default?: unknown };
      try {
        ns = (await import(entry)) as { default?: unknown };
      } catch (err) {
        drifts.push(`${pkg}: 源码导入失败，对账无法进行：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!isDefinition(ns.default)) {
        drifts.push(`${pkg}: default 导出不是插件定义（须 export default definePlugin({ … })）`);
        continue;
      }
      const def = ns.default;
      const uses = (def.uses ?? {}) as Uses;
      const svc = meta.aalis?.service ?? {};
      const pairs: Array<[string, string[], string[]]> = [
        ['provides', names(svc.provides), names(def.provides?.map(d => d.name))],
        ['required', names(svc.required), names(requiredNames(uses))],
        ['optional', names(svc.optional), names(optionalNames(uses))],
      ];
      for (const [field, manifest, code] of pairs) {
        if (JSON.stringify(manifest) !== JSON.stringify(code)) {
          drifts.push(`${pkg}.${field}: package.json=[${manifest.join(',')}] 代码=[${code.join(',')}]`);
        }
      }
    }
    expect(audited).toBeGreaterThan(50); // 防自僵：现扫描面 60 包，塌方要出声
    expect(
      drifts,
      `双源漂移：aalis.service（市场/预检读它）与 default 定义的 provides/uses（运行时真相）必须一致。\n` +
        `修法=以代码为准更新 package.json（或反之，若代码漏声明）：\n${drifts.join('\n')}`,
    ).toEqual([]);
  }, 120_000);
});

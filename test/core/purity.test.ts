import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// core 纯度守卫
//
// 1) 词汇禁令：呈现层/政策词汇不得出现在 core 源码——表单词汇归
//    @aalis/plugin-config-api，配置同步政策归 @aalis/runtime。
// 2) 公开面快照：core 的运行时导出与 Context 表面是版本承诺面，
//    任何增删必须是有意识的决定（同步更新本清单 = 留下决策记录）。
// ════════════════════════════════════════════════════════════

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../packages/core/src');

/** 呈现层/政策词汇黑名单：命中即说明词汇正在渗回内核 */
const BANNED_TOKENS = [
  'ConfigSchema',
  'SchemaField',
  'SchemaGroup',
  'SchemaArray',
  'textarea',
  'multiselect',
  'CORE_CONFIG_SCHEMA',
  'syncPluginDefaults',
  'trimUnknownFields',
  'deepMergeDefaults',
  'removeExtraFields',
];

function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkTs(p);
    else if (name.endsWith('.ts')) yield p;
  }
}

describe('core 词汇禁令（呈现层/政策词汇不得渗回内核）', () => {
  it('core 源码不含任何表单/配置政策词汇', () => {
    const violations: string[] = [];
    for (const file of walkTs(SRC_DIR)) {
      const source = readFileSync(file, 'utf-8');
      for (const token of BANNED_TOKENS) {
        if (source.includes(token)) {
          violations.push(`${file.slice(SRC_DIR.length + 1)}: ${token}`);
        }
      }
    }
    expect(violations, '表单词汇归 plugin-config-api、配置政策归 runtime——不要加回 core').toEqual([]);
  });
});

describe('core 公开面快照（增删必须是有意识的决定）', () => {
  it('运行时导出定格', () => {
    expect(Object.keys(core).sort()).toEqual([
      'App',
      'ConfigManager',
      'Context',
      'ContributionRegistry',
      'DefaultLogger',
      'EventBus',
      'HookRegistry',
      'LogHub',
      'PluginManager',
      'ServiceContainer',
      'ServicePriority',
      'createApp',
      'formatLogLine',
      'parseInstanceId',
      'parseLogLine',
    ]);
  });

  it('Context 表面定格（四原语 8 动词 + services 读写面 + 生命周期）', () => {
    expect(Object.getOwnPropertyNames(core.Context.prototype).sort()).toEqual([
      '_teardown', // 私有实现（JS 层可见,不属承诺面）
      'collect',
      'constructor',
      'contribute',
      'contributionDisposerCount', // @internal 诊断
      'disposableCount', // @internal 诊断
      'dispose',
      'disposeAsync',
      'disposed',
      'emit',
      'fork',
      'getAllServices',
      'getPreferredService',
      'getService',
      'getServiceNames',
      'middleware',
      'on',
      'onDispose',
      'preferService',
      'provide',
      'runHook',
      'serviceContainer', // @internal host 巡视
      'trackDisposable', // 私有实现（JS 层可见,不属承诺面）
      'unpreferService',
      'useModule',
      'whenService',
    ]);
  });
});

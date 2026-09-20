import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// core 纯度守卫
//
// 1) 词汇禁令：呈现层/政策词汇不得出现在 core 源码——表单词汇归
//    @aalis/schema-config，配置同步政策归 @aalis/runtime。
// 2) 公开面快照：core 包根的运行时导出是版本承诺面，任何增删必须是
//    有意识的决定（同步更新本清单 = 留下决策记录）。激活记录类
//    Context 不从包根导出，其表面不是公开契约。
// ════════════════════════════════════════════════════════════

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../packages/core/src');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

/** 包根运行时导出定格：与 packages/core/src/index.ts 的值导出对齐，不从 index 自动派生 */
const RUNTIME_EXPORTS = [
  'App',
  'ConfigManager',
  'ContributionRegistry',
  'DefaultLogger',
  'EventBus',
  'HookRegistry',
  'LogHub',
  'PluginManager',
  'ServiceContainer',
  'appService',
  'config',
  'contributions',
  'createApp',
  'definePlugin',
  'defineService',
  'events',
  'formatLogLine',
  'hooks',
  'hostConfig',
  'lifecycle',
  'logger',
  'optional',
  'parseInstanceId',
  'parseLogLine',
  'pluginsService',
  'provide',
  'serviceRef',
  'services',
];

/** 已删机制或内部实现，不得从包根出现 */
const FORBIDDEN_ROOT_EXPORTS = [
  'Context',
  'DisposableService',
  'InjectDeclaration',
  'PluginModule',
  'ServiceTypeMap',
  'requiresBounceOnDepChange',
  'unwrapPluginModule',
  'useModule',
] as const;

function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkTs(p);
    else if (name.endsWith('.ts')) yield p;
  }
}

function runTscProbe(source: string): string[] {
  // 夹具必须在仓内：tsconfig.test.json 的 rootDir 是仓根，path-mapped 进来的 core 源码要在其下。
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.aalis-type-probe-'));
  try {
    writeFileSync(join(dir, 'fixture.ts'), source);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(ROOT, 'tsconfig.test.json'),
        compilerOptions: { noEmit: true },
        include: [join(dir, 'fixture.ts')],
      }),
    );
    const res = spawnSync(
      join(ROOT, 'node_modules/.bin/tsc'),
      ['-p', join(dir, 'tsconfig.json'), '--pretty', 'false'],
      {
        cwd: ROOT,
        encoding: 'utf-8',
      },
    );
    if (res.error) throw res.error;
    return `${res.stdout ?? ''}${res.stderr ?? ''}`.split('\n').filter(l => l.includes('error TS'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    expect(violations, '表单词汇归 schema-config、配置政策归 runtime——不要加回 core').toEqual([]);
  });
});

describe('core 公开面快照（增删必须是有意识的决定）', () => {
  it('运行时导出定格', () => {
    expect(Object.keys(core).sort()).toEqual([...RUNTIME_EXPORTS].sort());
  });

  it('包根不得导出已删机制与内部激活记录', () => {
    const present = FORBIDDEN_ROOT_EXPORTS.filter(name => name in core);
    expect(present, '这些标识已不是公开契约，不得从 @aalis/core 包根出现').toEqual([]);
  });

  it('类型面不得从包根导入已删标识（去掉这些 import 后探针能编过）', () => {
    const header = `import { App } from '@aalis/core';\nvoid App;\n`;
    const forbidden = `import type {
  Context,
  DisposableService,
  InjectDeclaration,
  PluginModule,
  ServiceTypeMap,
} from '@aalis/core';
import { requiresBounceOnDepChange, unwrapPluginModule, useModule } from '@aalis/core';
`;
    const good = runTscProbe(header);
    expect(good, `合法探针应能编过，实际：${good.join('\n') || '（零错误）'}`).toEqual([]);

    const errs = runTscProbe(header + forbidden);
    expect(errs.length, `禁止导出的标识应从包根不可见，实际：${errs.join('\n') || '（零错误）'}`).toBeGreaterThan(0);
    for (const name of FORBIDDEN_ROOT_EXPORTS) {
      expect(
        errs.some(e => e.includes(name)),
        `${name} 应无法从包根导入，实际：${errs.join('\n')}`,
      ).toBe(true);
    }
  });

  it('公开 PluginEntry 类型不含 context 字段', () => {
    const good = `import type { PluginEntry } from '@aalis/core';
declare const entry: PluginEntry;
export const id: string = entry.instanceId;
export const state = entry.state;
`;
    const bad = `${good}export const leaked = entry.context; // BAD
`;
    const goodErrs = runTscProbe(good);
    expect(goodErrs, `去掉 context 访问应能编过，实际：${goodErrs.join('\n') || '（零错误）'}`).toEqual([]);

    const errs = runTscProbe(bad);
    const badLine = bad.split('\n').findIndex(l => l.includes('// BAD')) + 1;
    const atBad = errs.filter(e => e.includes(`fixture.ts(${badLine},`));
    expect(
      atBad.length,
      `第 ${badLine} 行应有类型错误（PluginEntry 无 context），实际：${errs.join('\n') || '（零错误）'}`,
    ).toBeGreaterThan(0);
  });

  it('包根 export from 路径不含内部 Context 模块', () => {
    const source = readFileSync(join(SRC_DIR, 'index.ts'), 'utf-8');
    const paths = [
      ...source.matchAll(/\bexport\s+(?:type\s+)?(?:\*\s+as\s+\w+\s+|\{[\s\S]*?\}\s+)?from\s+['"]([^'"]+)['"]/g),
    ].map(m => m[1]!);
    expect(
      paths.filter(p => p.includes('context/context')),
      `包根不得经内部 Context 再导出，实际：${paths.join(', ')}`,
    ).toEqual([]);
  });

  it('类型面不得从包根导入内部 ServiceEntry', () => {
    const errs = runTscProbe(`import type { ServiceEntry } from '@aalis/core';\n`);
    expect(
      errs.some(e => e.includes('ServiceEntry')),
      `ServiceEntry 应无法从包根导入，实际：${errs.join('\n') || '（零错误）'}`,
    ).toBe(true);
  });
});

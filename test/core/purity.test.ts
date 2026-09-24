import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as core from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// core 纯度守卫
//
// 1) 词汇禁令：呈现层/政策词汇不得出现在 core 源码——表单词汇归
//    @aalis/schema-config，配置同步政策归 @aalis/runtime。
// 2) 公开面快照：core 包根的运行时导出是版本承诺面，任何增删必须是
//    有意识的决定（同步更新本清单 = 留下决策记录）。激活记录类
//    Activation 与 ActivationHost 不从包根导出，其表面不是公开契约。
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
  'DefaultLogger',
  'LogHub',
  'appService',
  'config',
  'createApp',
  'definePlugin',
  'defineService',
  'events',
  'lifecycle',
  'logger',
  'optional',
  'parseInstanceId',
  'pluginsService',
  'provide',
  'serviceRef',
  'services',
];

/** 已删机制或内部实现，不得从包根出现 */
const FORBIDDEN_ROOT_EXPORTS = [
  'formatLogLine',
  'parseLogLine',
  'ModuleHandle',
  'EventBus',
  'HookRegistry',
  'ServiceContainer',
  'ContributionRegistry',
  'PluginManager',
  'serviceFactory',
  'ServiceFactory',
  'ServiceScope',
  'Context',
  'Activation',
  'ActivationHost',
  'Resources',
  'BindingScope',
  'CapabilityScope',
  'ServiceRuntime',
  'DisposableService',
  'InjectDeclaration',
  'PluginModule',
  'ServiceTypeMap',
  'requiresBounceOnDepChange',
  'unwrapPluginModule',
  'useModule',
  // 0.18：插件发现与配置文档外迁到宿主（@aalis/runtime、@aalis/api-plugin-source、@aalis/api-host-config）
  'PluginLoader',
  'PluginDescriptor',
  'pluginDefinitionOf',
  'ConfigManager',
  'ConfigManagerOptions',
  'ConfigProvider',
  'AalisConfig',
  'HostConfig',
  'hostConfig',
  // 0.18：钩子与贡献点拆为契约包 + 插件（@aalis/api-hooks、@aalis/api-contributions）
  'hooks',
  'contributions',
  'Hooks',
  'Contributions',
  'HookContextMap',
  'ContributionPointMap',
  'MiddlewareFn',
  'MiddlewareNext',
  'ContributionSpec',
  'ContributionHandle',
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
  ModuleHandle,
  ServiceFactory,
  ServiceScope,
  Context,
  Activation,
  ActivationHost,
  Resources,
  BindingScope,
  CapabilityScope,
  ServiceRuntime,
  DisposableService,
  InjectDeclaration,
  PluginModule,
  ServiceTypeMap,
  PluginLoader,
  PluginDescriptor,
  ConfigManagerOptions,
  ConfigProvider,
  AalisConfig,
  HostConfig,
  Hooks,
  Contributions,
  HookContextMap,
  ContributionPointMap,
  MiddlewareFn,
  MiddlewareNext,
  ContributionSpec,
  ContributionHandle,
} from '@aalis/core';
import { ContributionRegistry, EventBus, formatLogLine, HookRegistry, parseLogLine, PluginManager, requiresBounceOnDepChange, ServiceContainer, serviceFactory, unwrapPluginModule, useModule, pluginDefinitionOf, ConfigManager, hostConfig, hooks, contributions } from '@aalis/core';
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

  it('类型面可以从包根导入 LogEntry / LogLevel', () => {
    const errs = runTscProbe(`import type { LogEntry, LogLevel } from '@aalis/core';
const level: LogLevel = 'info';
const entry: LogEntry = { seq: 0, timestamp: 't', level, scope: 's', message: 'm' };
void entry;
`);
    expect(errs, `LogEntry / LogLevel 应可从 @aalis/core 导入，实际：${errs.join('\n') || '（零错误）'}`).toEqual([]);
  });

  it.each(['context', 'activation'])('公开 PluginEntry 类型不含 %s 字段', field => {
    const good = `import type { PluginEntry } from '@aalis/core';
declare const entry: PluginEntry;
export const id: string = entry.instanceId;
export const state = entry.state;
`;
    const bad = `${good}export const leaked = entry.${field}; // BAD
`;
    const goodErrs = runTscProbe(good);
    expect(goodErrs, `去掉内部记录访问应能编过，实际：${goodErrs.join('\n') || '（零错误）'}`).toEqual([]);

    const errs = runTscProbe(bad);
    const badLine = bad.split('\n').findIndex(l => l.includes('// BAD')) + 1;
    const atBad = errs.filter(e => e.includes(`fixture.ts(${badLine},`));
    expect(
      atBad.length,
      `第 ${badLine} 行应有类型错误（PluginEntry 无 ${field}），实际：${errs.join('\n') || '（零错误）'}`,
    ).toBeGreaterThan(0);
  });

  it('包根 export from 路径不含内部激活、资源或装配模块', () => {
    const source = readFileSync(join(SRC_DIR, 'index.ts'), 'utf-8');
    const paths = [
      ...source.matchAll(/\bexport\s+(?:type\s+)?(?:\*\s+as\s+\w+\s+|\{[\s\S]*?\}\s+)?from\s+['"]([^'"]+)['"]/g),
    ].map(m => m[1]!);
    expect(
      paths.filter(p =>
        /(?:context\/(?:context|resources|capabilities)|orchestration\/activation(?:-host)?)\.js$/.test(p),
      ),
      `包根不得经内部实现模块再导出，实际：${paths.join(', ')}`,
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

/** 激活记录只保存身份、资源与依赖边，不重新长成通用能力门面。 */
function activationViolations(source: string): string[] {
  const allowedMethods = new Set([
    'retainBinding',
    'dropOutbound',
    'handover',
    'closeInfo',
    'joinPlan',
    'disposeAsync',
  ]);
  const allowedFields = new Set(['children', 'declared', 'outbound', 'inbound', 'closing']);
  const violations: string[] = [];
  const file = ts.createSourceFile('activation.ts', source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'Activation') {
      found = true;
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && !allowedFields.has(member.name.getText(file))) {
          violations.push(`Activation 不得增加能力字段 ${member.name.getText(file)}`);
        }
        if (
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)
        ) {
          const name = member.name.getText(file);
          if (!allowedMethods.has(name)) violations.push(`Activation 不得提供能力门面 ${name}`);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(file);
      if (receiver === 'this.services' && node.expression.name.text !== 'ownerOf') {
        violations.push(`激活记录只读取提供者身份，不执行服务操作 ${node.expression.name.text}`);
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const path = node.moduleSpecifier.text;
      if (/\/(?:builtins|capabilities|config|definition|activation-host|events)\.js$/.test(path)) {
        violations.push(`Activation 不得依赖能力实现或装配器 ${path}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) violations.push('未发现 Activation，守卫不能空转');
  return violations;
}

describe('内部激活记录保持窄职责，旧 Context 不得回归', () => {
  it('Activation 不导入或实现原语门面，只读取服务归属用于依赖边', () => {
    const source = readFileSync(join(SRC_DIR, 'orchestration/activation.ts'), 'utf8');
    expect(activationViolations(source)).toEqual([]);
  });

  it('旧实现文件、Context 类和 whenService 中转方法均已移除', () => {
    expect(existsSync(join(SRC_DIR, 'context/context.ts'))).toBe(false);
    const offenders: string[] = [];
    for (const file of walkTs(SRC_DIR)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) && node.name?.text === 'Context') offenders.push(`${file}: Context`);
        if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'whenService')
          offenders.push(`${file}: whenService`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    'class Activation { provide() {} }',
    'class Activation { provide = () => {}; }',
    'class Activation { get events() { return this.bus; } }',
    'class Activation { closeInfo() { this.services.register("x", {}, "id"); } }',
    'import { events } from "../context/builtins.js"; class Activation {}',
  ])('变异被拒绝：%s', source => {
    expect(activationViolations(source).length).toBeGreaterThan(0);
  });
});

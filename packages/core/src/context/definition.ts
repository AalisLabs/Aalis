// ============================================================
// definition.ts — 插件定义与挂载
//
// 插件是一份定义：名字、用到的能力（uses）、提供的服务、元数据，以及拿到绑定接口后的 apply。
// 调度器挂顶层插件、lifecycle.module 挂子模块，走的是同一个 mountDefinition：
// 写入这次激活的配置 → 按 uses 装配绑定接口 → 调 apply。
// ============================================================

import { assemble, type BoundOf, isOptional, type ServiceDescriptor, type Uses } from './binding.js';
import type { Context } from './context.js';

/**
 * 插件元数据的扩展点：core 对这里的字段零感知，只原样带在插件定义上。配置表单（configSchema）由
 * @aalis/schema-config、对 core 的扩展声明（extends）由 @aalis/api-webui 经 declaration merging 挂进来。
 */
export interface PluginMeta {}

// biome-ignore lint/complexity/noBannedTypes: 无声明时的空声明表
export interface PluginDefinition<U extends Uses = {}> extends PluginMeta {
  /**
   * 插件名，与 package.json 的 name 一致；单实例时即实例 id。
   * 须为非空字符串，且不含 instanceId 的 `:suffix`（parseInstanceId 从 '/' 之后切开）与子模块的 `#`。
   */
  name: string;
  displayName?: string;
  /**
   * 归类标签，与 displayName 同为展示元数据：core 不读、不校验取值，管理界面据它分组。
   * 第一方界面认的 id 见 @aalis/api-webui 的 DEFAULT_SUBSYSTEM_METADATA，其它字符串原样显示。
   */
  subsystem?: string;
  /**
   * 用到的全部能力：键是 apply 里的参数名，值是描述符（内置能力从 @aalis/core、其余从契约包导入）；
   * 可选依赖包一层 optional()。没有默认注入——这里写了什么，插件就只能碰到什么。
   */
  uses?: U;
  /**
   * 本插件提供的服务（激活后按本次激活的 instanceId 校验确已提供）。
   * `provide(..., { onBehalfOf })` 代登记的条目归属被代者身份，不计入代理人：
   * 若把代登记的服务写进本清单，会以「声明 provides 但未实际注册」进入 error。
   */
  // biome-ignore lint/suspicious/noExplicitAny: 描述符泛型只作推导载体
  provides?: ServiceDescriptor<any, any>[];
  /** 核心插件不能被用户禁用 */
  core?: boolean;
  /**
   * 允许同一份定义以不同配置多次注册（`name:suffix`），每个实例有独立的激活、配置与 id。
   * 默认 false：同一份定义只能注册一次。适合多实例的有 LLM / embedding / 平台适配器、存储后端等。
   */
  reusable?: boolean;
  apply(caps: BoundOf<U>): void | Promise<void>;
}

/**
 * id 形状的公共闸：非空字符串，且不含 `#`（子模块 id 是 `父id#模块名`）。
 * `definition.name` 额外禁止 `:suffix`；`register` 第三参 instanceId 允许 `name:suffix`。
 */
function assertValidId(id: unknown, kind: 'name' | 'instanceId'): asserts id is string {
  if (typeof id !== 'string' || id === '') {
    throw new Error(
      kind === 'name' ? '插件定义缺少合法 name（须为非空字符串）' : '插件缺少合法 instanceId（须为非空字符串）',
    );
  }
  if (id.includes('#')) {
    throw new Error(
      kind === 'name'
        ? `插件 "${id}" 的 name 不能包含 "#"——"#" 是子模块 id 的分隔符（父id#模块名）`
        : `instanceId "${id}" 不能包含 "#"——"#" 是子模块 id 的分隔符（父id#模块名）`,
    );
  }
}

/** register 第三参：与 name 同一套非空 / `#` 闸；`:suffix` 合法（多实例）。 */
export function assertValidInstanceId(id: unknown): asserts id is string {
  assertValidId(id, 'instanceId');
}

function assertValidPluginName(name: unknown): asserts name is string {
  assertValidId(name, 'name');
  const slashIdx = name.indexOf('/');
  const searchFrom = slashIdx >= 0 ? slashIdx + 1 : 0;
  if (name.includes(':', searchFrom)) {
    throw new Error(
      `插件 "${name}" 的 name 不能带实例后缀——":suffix" 只用于 instanceId（parseInstanceId 从 '/' 之后切开），不进定义 name`,
    );
  }
}

/** 校验一份定义：name 合法，且 uses 每一项都是描述符（或 optional 包着的描述符） */
export function validateDefinition(definition: PluginDefinition): void {
  assertValidPluginName(definition.name);
  for (const [key, use] of Object.entries(definition.uses ?? {})) {
    const descriptor = isOptional(use) ? use.optional : use;
    if (typeof (descriptor as { bind?: unknown } | null)?.bind !== 'function') {
      throw new Error(`插件 "${definition.name}" 的 uses.${key} 不是服务描述符（应为 defineService 的结果）`);
    }
  }
}

/**
 * 定义一个插件。运行期只做声明表校验并原样返回——它存在是为了让 apply 的参数类型从 uses 推导出来，
 * 并把写错的声明（例如被 apply 解构出的同名绑定遮住的描述符）在模块加载时就报出来。
 */
// biome-ignore lint/complexity/noBannedTypes: 同上
export function definePlugin<U extends Uses = {}>(definition: PluginDefinition<U>): PluginDefinition<U> {
  validateDefinition(definition);
  return definition;
}

const activationConfig = new WeakMap<Context, Readonly<Record<string, unknown>>>();

/** @internal 这次激活的插件配置（内置能力 config 的数据源） */
export function activationConfigOf(ctx: Context): Readonly<Record<string, unknown>> {
  return activationConfig.get(ctx) ?? {};
}

/**
 * @internal 在一次激活上挂载定义。任一 bind 抛错即整体失败：调用方拆掉这次激活，已装配部分经撤回段回滚。
 */
export function mountDefinition(
  ctx: Context,
  definition: PluginDefinition,
  config: Record<string, unknown>,
): void | Promise<void> {
  activationConfig.set(ctx, config);
  return definition.apply(assemble(ctx, definition.uses ?? {}));
}

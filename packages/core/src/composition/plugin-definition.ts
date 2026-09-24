// ============================================================
// definition.ts — 插件定义与挂载
//
// 插件是一份定义：名字、用到的能力（uses）、提供的服务、元数据，以及拿到绑定接口后的 apply。
// 调度器挂载时：写入这次激活的配置 → 按 uses 装配绑定接口 → 调 apply。
// ============================================================

import { assertOwnCopy, type BoundOf, isOptional, type ServiceDescriptor, type Uses } from './descriptors.js';
import { isPlainConfigObject, isUnsafeConfigKey } from '../infrastructure/config-values.js';

/**
 * 插件元数据的扩展点：core 对这里的字段零感知，只原样带在插件定义上。配置表单（configSchema）由
 * @aalis/schema-config、对 core 的扩展声明（extends）由 @aalis/api-webui 经 declaration merging 挂进来。
 */
export interface PluginMeta {}

// biome-ignore lint/complexity/noBannedTypes: 无声明时的空声明表
export interface PluginDefinition<U extends Uses = {}> extends PluginMeta {
  /**
   * 插件名，与 package.json 的 name 一致；单实例时即实例 id。
   * 须为 trim 后非空的字符串，不能是 `__proto__` / `constructor` / `prototype`，
   * 且不含 instanceId 的 `:suffix`（parseInstanceId 从 '/' 之后切开）与保留字符 `#`。
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
 * id 形状的公共闸：trim 后非空，不是配置层危险键（`__proto__` / `constructor` / `prototype`），
 * 且不含保留字符 `#`。
 * `definition.name` 额外禁止 `:suffix`；`register` 第三参 instanceId 允许 `name:suffix`。
 */
function assertValidId(id: unknown, kind: 'name' | 'instanceId'): asserts id is string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(
      kind === 'name' ? '插件定义缺少合法 name（须为非空字符串）' : '插件缺少合法 instanceId（须为非空字符串）',
    );
  }
  if (isUnsafeConfigKey(id) || isUnsafeConfigKey(id.trim())) {
    throw new Error(
      kind === 'name'
        ? `插件 "${id}" 的 name 不能使用危险键（__proto__ / constructor / prototype）`
        : `instanceId "${id}" 不能使用危险键（__proto__ / constructor / prototype）`,
    );
  }
  if (id.includes('#')) {
    throw new Error(
      kind === 'name' ? `插件 "${id}" 的 name 不能包含保留字符 "#"` : `instanceId "${id}" 不能包含保留字符 "#"`,
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

function isServiceDescriptor(value: unknown): boolean {
  return typeof (value as { bind?: unknown } | null)?.bind === 'function';
}

/** 校验一份定义：name 合法，uses 为纯对象且每一项都是描述符，apply 是函数，provides 元素都是描述符 */
export function validateDefinition(definition: PluginDefinition): void {
  assertValidPluginName(definition.name);
  if (definition.uses !== undefined && !isPlainConfigObject(definition.uses)) {
    throw new Error(`插件 "${definition.name}" 的 uses 必须是纯对象（不能是数组或原始值）`);
  }
  for (const [key, use] of Object.entries(definition.uses ?? {})) {
    assertOwnCopy(use, `插件 "${definition.name}" 的 uses.${key} `);
    const descriptor = isOptional(use) ? use.optional : use;
    assertOwnCopy(descriptor, `插件 "${definition.name}" 的 uses.${key} `);
    if (!isServiceDescriptor(descriptor)) {
      throw new Error(`插件 "${definition.name}" 的 uses.${key} 不是服务描述符（应为 defineService 的结果）`);
    }
  }
  if (typeof definition.apply !== 'function') {
    throw new Error(`插件 "${definition.name}" 的 apply 必须是函数`);
  }
  for (const item of definition.provides ?? []) {
    assertOwnCopy(item, `插件 "${definition.name}" 的 provides 元素`);
    if (!isServiceDescriptor(item)) {
      throw new Error(`插件 "${definition.name}" 的 provides 含有不是描述符的元素（${String(item)}）`);
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

/**
 * 从已导入的模块取出插件定义：入口的 default 须是 definePlugin 的产物（带非空 name 与 apply 的对象）。
 * 对不上返回 null。加载器与包管理都走这里——「是不是插件 / 名字是什么」只有这一份判定。
 *
 * default 为函数或类不算：它们天然继承 Function.prototype.apply，只查 `.apply` 会把
 * `export default function` 误当插件，随后被调用的是 Function.prototype.apply——插件体空跑却被标记已激活。
 */
export function pluginDefinitionOf(mod: unknown): PluginDefinition | null {
  const candidate = (mod as { default?: unknown } | null)?.default as Partial<PluginDefinition> | null | undefined;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.name !== 'string' ||
    candidate.name === '' ||
    typeof candidate.apply !== 'function'
  ) {
    return null;
  }
  return candidate as PluginDefinition;
}

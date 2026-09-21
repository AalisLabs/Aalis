/**
 * 配置对象的危险键闸与纯对象/数组拷贝。
 *
 * 两条合并路径语义不同（插件配置深合并 vs 宿主快照浅填），不能合成一个函数；
 * 但外来 JSON / YAML 都会把 `__proto__` 解成自有键，逐键赋值会换掉结果对象的原型。
 * `constructor` / `prototype` 同属配置层无合法含义的键，一并跳过。
 *
 * 拷贝只服务「调用方不得通过别名写穿 ConfigManager / schema.default」：
 * 纯对象递归拷、数组拷一层（元素若为纯对象也拷）；Date / Map / 类实例等原子值
 * 按引用透传，调用方不得依赖其不可变。
 *
 * 规则与 `@aalis/schema-config` 的 `cloneConfigObject` 对齐（该包零运行时依赖，不能 import 这里）。
 * 防漂移：`test/architecture/config-copy-parity.test.ts`。
 */

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isUnsafeConfigKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

/**
 * 插件 id 不得当 `plugins` / 禁用名单的对象键——那三条会落到原型链。
 * ConfigManager 按 id 取放的入口共用这一抛错，文案给 WebUI 映射 400。
 */
export function assertSafePluginId(id: string): void {
  if (isUnsafeConfigKey(id)) {
    throw new Error(`插件 id 不合法: ${id}`);
  }
}

export function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => (isPlainConfigObject(item) ? cloneConfigObject(item) : item));
  }
  if (isPlainConfigObject(value)) return cloneConfigObject(value);
  return value;
}

export function cloneConfigObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isUnsafeConfigKey(key)) continue;
    out[key] = cloneConfigValue(value);
  }
  return out;
}

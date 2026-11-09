/**
 * 配置值的危险键闸与纯对象/数组拷贝。
 *
 * 外来 JSON / YAML 都会把 `__proto__` 解成自有键，逐键赋值会换掉结果对象的原型。
 * `constructor` / `prototype` 同属配置层无合法含义的键，一并跳过。
 *
 * 拷贝只服务「调用方与插件不得通过别名写穿实例配置」：登记与 updateConfig 时把入参拷进注册表，每次激活与 getPlugin 再各交一份拷贝。
 * 纯对象与普通数组逐层拷，同一条路径上再遇到自己即环，抛错；共享而无环的引用照常拷成两份。
 * Date / Map / 类实例（含数组子类）等原子值按引用透传，调用方不得依赖其不可变。
 *
 * 规则与 `@aalis/schema-config` 的 `cloneConfigObject` 对齐（core 不依赖任何包；该包不依赖 core 的运行时，
 * WebUI 前端也引它）。防漂移：`test/architecture/config-copy-parity.test.ts`。
 */

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isUnsafeConfigKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

export function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 原型就是 Array.prototype 的数组：子类的 map 会经 species 重新构造实例，按类实例透传 */
function isPlainConfigArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

/** 自有可枚举键逐个拷进新的纯对象，危险键跳过 */
function cloneEntries(obj: object, path: Set<object>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([key]) => !isUnsafeConfigKey(key))
      .map(([key, item]) => [key, cloneConfigValue(item, path)]),
  );
}

/** path：当前这条路径上的纯对象与数组。抛错时整次拷贝作废，path 不必复原 */
function cloneConfigValue(value: unknown, path: Set<object>): unknown {
  const array = isPlainConfigArray(value);
  if (!array && !isPlainConfigObject(value)) return value;
  if (path.has(value)) throw new Error('配置里有环状引用');
  path.add(value);
  const out = array ? value.map(item => cloneConfigValue(item, path)) : cloneEntries(value, path);
  path.delete(value);
  return out;
}

/** 总是新建纯对象：入参是类实例时取它的自有可枚举键；null、undefined 抛错 */
export function cloneConfigObject(obj: Record<string, unknown>): Record<string, unknown> {
  return cloneEntries(obj, new Set([obj]));
}

/** 管理动作收下的配置：只收纯对象，null、数组、原始值与类实例抛错（不改形、不当空配置），再拷成自己的一份 */
export function ownConfigObject(value: unknown): Record<string, unknown> {
  if (!isPlainConfigObject(value)) throw new Error('配置须为纯对象，不能是 null、数组、原始值或类实例');
  return cloneConfigObject(value);
}

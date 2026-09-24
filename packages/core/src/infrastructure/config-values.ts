/**
 * 配置值的危险键闸与纯对象/数组拷贝。
 *
 * 外来 JSON / YAML 都会把 `__proto__` 解成自有键，逐键赋值会换掉结果对象的原型。
 * `constructor` / `prototype` 同属配置层无合法含义的键，一并跳过。
 *
 * 拷贝只服务「调用方不得通过别名写穿实例配置」：登记与 bounce 时把入参拷进 entry。
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

export function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneConfigValue(value: unknown): unknown {
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

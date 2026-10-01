// ============================================================
// secrets —— 配置文档与运行态之间的密钥换算（纯函数，不碰文件）
//
// schema 里 `secret: true` 的字段在文档里是引用 `{ $secret: '<键>' }`，值在宿主的密钥存储（家目录的 secrets.yaml）；
// 交给 core（也就是插件）之前解析回原值。字段的位置只认 schema-config 的 mapSecretFields。
// ============================================================

import { type ConfigSchema, isSecretRef, mapSecretFields } from '@aalis/schema-config';

/** 密钥字段上算「有值」的明文：非空。`''`、null、空 map、空 list 是没填，不进密钥存储 */
export function isSecretValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (isSecretRef(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * 两份配置是否相同：结构比较，与键序无关。配置经合并默认值、表单重建后键序可能不同，按 JSON 字符串比较会误判为有改动、
 * 白白重建插件
 */
export function sameConfig(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameConfig(x, b[i]));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && sameConfig(left[key], right[key]))
  );
}

/** 值里出现的全部引用的键。不看 schema：用来判断一个键还有没有人用，宁可多算 */
export function referencedKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (isSecretRef(value)) into.add(value.$secret);
  else if (Array.isArray(value)) for (const item of value) referencedKeys(item, into);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) referencedKeys(v, into);
  return into;
}

/** 密钥字段上的非空明文所在的路径（只收文档形态的写入口据此拒绝） */
export function plainSecretPaths(schema: ConfigSchema | undefined, config: Record<string, unknown>): string[] {
  const paths: string[] = [];
  mapSecretFields(schema, config, (value, at) => {
    if (isSecretValue(value)) paths.push(at.path);
    return value;
  });
  return [...new Set(paths)];
}

export interface SplitSecrets {
  /** 文档形态：密钥字段上只剩引用或没填的空值 */
  doc: Record<string, unknown>;
  /** 要写进密钥存储的键值，由调用方在生效后提交 */
  writes: Map<string, unknown>;
  /** 新值落到的位置与键（日志用，不带值） */
  placed: Array<{ path: string; key: string }>;
}

/**
 * 提交的配置拆成文档形态：密钥字段上的非空明文换成引用，值放进 writes。
 * - 顶层与分组里的字段：写进 `base`（该实例当前的文档）在同一位置引用的键，键被别处共用时一并改到它们；
 *   那里没有引用就取新键。
 * - 数组元素里的字段：一律取新键。元素可能被重排、增删，按下标找到的可能是别的元素的键。
 * 新键是 `<实例 id>.<字段路径>`（数组元素的路径不带下标），`taken` 认为被占用时依次加 `-2`、`-3`。
 */
export function splitSecrets(
  schema: ConfigSchema | undefined,
  instanceId: string,
  submitted: Record<string, unknown>,
  base: Record<string, unknown>,
  taken: (key: string) => boolean,
): SplitSecrets {
  const writes = new Map<string, unknown>();
  const placed: SplitSecrets['placed'] = [];
  const doc = mapSecretFields(schema, submitted, (value, at) => {
    if (!isSecretValue(value)) return value;
    const key =
      (at.inArray ? undefined : refAt(base, at.path)) ??
      freshKey(`${instanceId}.${at.path}`, k => taken(k) || writes.has(k));
    writes.set(key, value);
    placed.push({ path: at.path, key });
    return { $secret: key };
  });
  return { doc, writes, placed };
}

export interface ResolvedSecrets {
  config: Record<string, unknown>;
  /** 引用的键不在密钥存储里：引用原样留在 config 里，插件的 parseConfig 会拒绝激活 */
  dangling: Array<{ path: string; key: string }>;
}

/**
 * 文档形态解析成运行态：密钥字段上的引用换成密钥存储里的值。键不在存储里时不回落任何东西，引用原样留着，
 * 让插件激活失败、点名键名（回落默认值会悄悄连上别的东西，例如默认的本机数据库）。
 */
export function resolveSecrets(
  schema: ConfigSchema | undefined,
  doc: Record<string, unknown>,
  lookup: (key: string) => { value: unknown } | undefined,
): ResolvedSecrets {
  const dangling: ResolvedSecrets['dangling'] = [];
  const config = mapSecretFields(schema, doc, (value, at) => {
    if (!isSecretRef(value)) return value;
    const hit = lookup(value.$secret);
    if (hit) return hit.value;
    dangling.push({ path: at.path, key: value.$secret });
    return value;
  });
  return { config, dangling };
}

/** 悬空引用的日志：点名实例、字段与键，不涉及值 */
export function describeDangling(instanceId: string, dangling: ResolvedSecrets['dangling']): string {
  const items = dangling.map(d => `${d.path}（键 ${d.key}）`).join('、');
  return `${instanceId} 引用的密钥不在 secrets.yaml 里：${items}；用 parseConfig 读配置的插件会激活失败，在 WebUI 重新填写或在 secrets.yaml 里补上这些键`;
}

/** 按点号路径取顶层或分组里那个位置上的引用键 */
function refAt(config: Record<string, unknown>, path: string): string | undefined {
  let value: unknown = config;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
  }
  return isSecretRef(value) ? value.$secret : undefined;
}

function freshKey(base: string, taken: (key: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const key = `${base}-${n}`;
    if (!taken(key)) return key;
  }
}

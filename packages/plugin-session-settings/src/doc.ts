// ════════════════════════════════════════════════════════════
// 宿主配置文档里的两层：sessionConfig 的平台档（platforms）与平台类型档（platformTypes），每处按插件实例 id 放这个实例的值。
// 读的时候核形状：不认识的段、名字不合层标识写法的条目、不是对象的实例值告警后忽略；既没登记、配置文档的 plugins 里也没有的
// 实例 id 告警一次，值留着不生效。值本身在解析时按字段校验。写的时候在原样的文档上只改这一处的这一项，读不懂的部分原样留着。
// 留空的段（配置文件里只剩键名，读出来是 null）读写都与没有这一段同样处理。
// ════════════════════════════════════════════════════════════

import { isUnsafeConfigKey } from '@aalis/schema-config';

/** 一个实例在一处写的值 */
export type Values = Record<string, unknown>;
/** 实例 id → 值 */
type Instances = Map<string, Values>;

/** 文档里的两层，形状已核过 */
export interface DocLayers {
  platforms: Map<string, Instances>;
  /** 平台 → 类型名 → 各实例的值 */
  platformTypes: Map<string, Map<string, Instances>>;
}

/** 层标识里的平台名与类型名：与窗口键 `平台:类型:目标` 的段同一套写法（非空、不含 `:`、不是 `*`），还要能当配置文档里的对象键 */
export function isLayerName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name !== '*' && !name.includes(':') && !isUnsafeConfigKey(name);
}

export const isRecord = (value: unknown): value is Values =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SECTIONS: ReadonlySet<string> = new Set(['platforms', 'platformTypes']);

/** 读文档时的两个依据：这个实例 id 认不认识（已登记或配置文档里有它的配置段），与告警（调用方去重） */
interface ReadContext {
  known(instance: string): boolean;
  warn(message: string): void;
}

/** 名字 → 对象的一张表：名字不合写法、值不是对象的告警后忽略 */
function table(value: unknown, path: string, ctx: ReadContext): Map<string, Values> {
  const out = new Map<string, Values>();
  if (value == null) return out;
  if (!isRecord(value)) {
    ctx.warn(`宿主配置 ${path} 不是对象，已忽略`);
    return out;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (!isLayerName(name)) ctx.warn(`宿主配置 ${path} 里的「${name}」不合法（非空、不含 :、不是 *），已忽略`);
    else if (isRecord(entry)) out.set(name, entry);
    else if (entry != null) ctx.warn(`宿主配置 ${path}.${name} 不是对象，已忽略`);
  }
  return out;
}

/** 一处各实例的值：实例值不是对象的告警后忽略，不认识的实例告警一次、照样留着 */
function instances(value: Values, path: string, ctx: ReadContext): Instances {
  const out: Instances = new Map();
  for (const [instance, values] of Object.entries(value)) {
    if (isUnsafeConfigKey(instance) || values == null) continue;
    if (!isRecord(values)) {
      ctx.warn(`宿主配置 ${path}.${instance} 不是对象，已忽略`);
      continue;
    }
    if (!ctx.known(instance)) ctx.warn(`宿主配置 ${path} 里的 ${instance} 不是已装的插件实例，这一段不生效`);
    out.set(instance, values);
  }
  return out;
}

/** 读出文档里的两层（交出的是复制品之上的整理结果） */
export function readDoc(doc: unknown, ctx: ReadContext): DocLayers {
  const layers: DocLayers = { platforms: new Map(), platformTypes: new Map() };
  if (doc == null) return layers;
  if (!isRecord(doc)) {
    ctx.warn('宿主配置 sessionConfig 不是对象，已忽略');
    return layers;
  }
  for (const key of Object.keys(doc)) {
    if (!SECTIONS.has(key)) {
      ctx.warn(`宿主配置 sessionConfig.${key} 不认识（只有 platforms、platformTypes），已忽略`);
    }
  }
  for (const [name, value] of table(doc.platforms, 'sessionConfig.platforms', ctx)) {
    layers.platforms.set(name, instances(value, `sessionConfig.platforms.${name}`, ctx));
  }
  for (const [platform, byType] of table(doc.platformTypes, 'sessionConfig.platformTypes', ctx)) {
    const path = `sessionConfig.platformTypes.${platform}`;
    layers.platformTypes.set(
      platform,
      new Map([...table(byType, path, ctx)].map(([type, value]) => [type, instances(value, `${path}.${type}`, ctx)])),
    );
  }
  return layers;
}

/**
 * 在原样的 sessionConfig 上只改一处（path 是 sessionConfig 之下到实例的各段）的这一项：stored 为 null 即删掉，删空了的对象沿路径
 * 逐级删掉（sessionConfig 自己留着）；别的部分（含读不懂的）原样留着。要写的路径上已有的值不是对象时不改，返回那一段的路径；删的
 * 时候路径不在就什么都不改
 */
export function putDocValue(
  doc: unknown,
  path: readonly string[],
  key: string,
  stored: unknown,
): { doc: unknown } | { notObject: string } {
  const segments = ['sessionConfig', ...path];
  const holder: Values = { sessionConfig: doc };
  const nodes = [holder];
  for (const [i, name] of segments.entries()) {
    const node = nodes[i];
    const next = Object.hasOwn(node, name) ? node[name] : undefined;
    if (next == null) {
      if (stored === null) return { doc };
      node[name] = {};
    } else if (!isRecord(next)) {
      return stored === null ? { doc } : { notObject: segments.slice(0, i + 1).join('.') };
    }
    nodes.push(node[name] as Values);
  }
  const target = nodes[segments.length];
  if (stored === null) delete target[key];
  else target[key] = stored;
  for (let i = segments.length; i > 1 && Object.keys(nodes[i]).length === 0; i--) delete nodes[i - 1][segments[i - 1]];
  return { doc: holder.sessionConfig };
}

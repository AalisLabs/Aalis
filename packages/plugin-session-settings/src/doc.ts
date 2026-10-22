// ════════════════════════════════════════════════════════════
// 宿主配置文档里的两层：sessionConfig 的平台档（platforms）与平台类型档（platformTypes），每处按插件实例 id 放这个实例的值。
// 读的时候核形状：不认识的段、名字不合层标识写法的条目、不是对象的实例值告警后忽略（按层写时整份重写，它们不再写回）；既没
// 登记、配置文档的 plugins 里也没有的实例 id 告警一次，值留着不生效。值本身在解析时按字段校验。
// ════════════════════════════════════════════════════════════

import type { SessionConfigDoc } from '@aalis/api-session-settings';
import { isUnsafeConfigKey } from '@aalis/schema-config';

/** 一个实例在一处写的值 */
export type Values = Record<string, unknown>;
/** 实例 id → 值 */
export type Instances = Map<string, Values>;

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
  if (value === undefined) return out;
  if (!isRecord(value)) {
    ctx.warn(`宿主配置 ${path} 不是对象，已忽略`);
    return out;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (!isLayerName(name)) ctx.warn(`宿主配置 ${path} 里的「${name}」不合法（非空、不含 :、不是 *），已忽略`);
    else if (isRecord(entry)) out.set(name, entry);
    else ctx.warn(`宿主配置 ${path}.${name} 不是对象，已忽略`);
  }
  return out;
}

/** 一处各实例的值：实例值不是对象的告警后忽略，不认识的实例告警一次、照样留着 */
function instances(value: Values, path: string, ctx: ReadContext): Instances {
  const out: Instances = new Map();
  for (const [instance, values] of Object.entries(value)) {
    if (isUnsafeConfigKey(instance)) continue;
    if (!isRecord(values)) {
      ctx.warn(`宿主配置 ${path}.${instance} 不是对象，已忽略`);
      continue;
    }
    if (!ctx.known(instance)) ctx.warn(`宿主配置 ${path} 里的 ${instance} 不是已装的插件实例，这一段不生效`);
    out.set(instance, values);
  }
  return out;
}

/** 读出文档里的两层（交出的是复制品之上的整理结果，调用方可以就地改） */
export function readDoc(doc: unknown, ctx: ReadContext): DocLayers {
  const layers: DocLayers = { platforms: new Map(), platformTypes: new Map() };
  if (doc === undefined) return layers;
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

/** 名字 → 内容的表写回：空了的条目删掉 */
function writeTable<T>(entries: Map<string, T>, write: (value: T) => object | undefined) {
  const kept = [...entries].flatMap(([name, value]) => {
    const written = write(value);
    return written ? [[name, written] as const] : [];
  });
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** 一处各实例的值写回：空了的实例删掉 */
const writeInstances = (entries: Instances) =>
  writeTable(entries, values => (Object.keys(values).length > 0 ? values : undefined));

/** 两层整理成文档的形状：空了的层与表删掉，形状不对、已被忽略的部分不再写回 */
export function writeDoc(layers: DocLayers): SessionConfigDoc {
  const doc: SessionConfigDoc = {};
  const platforms = writeTable(layers.platforms, writeInstances);
  const platformTypes = writeTable(layers.platformTypes, byType => writeTable(byType, writeInstances));
  if (platforms) doc.platforms = platforms as SessionConfigDoc['platforms'];
  if (platformTypes) doc.platformTypes = platformTypes as SessionConfigDoc['platformTypes'];
  return doc;
}

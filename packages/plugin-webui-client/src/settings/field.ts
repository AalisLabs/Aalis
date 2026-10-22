import type { SettingRow } from '@aalis/api-session-protocol';
import { isSessionField, type WireSchemaField } from '@aalis/schema-config';
import type { Localized } from '@aalis/schema-i18n';
import { listText } from '../format';
import { tr } from '../language';
import { isRecord } from '../rest';

// 设置项、插件配置与页面动作输入的字段（schema-config 的词汇）：取值写成一句、选项的键、作者默认的说法，以及可选项接口回应的
// 解析。前端不认识任何设置键，只按字段类型与声明渲染；模型字段（llm-ref）的取值是 { provider, model }，可选项来自模型服务

/** 设置的一行：给人看的文字已按读者语言渲染成字符串 */
export type Row = Localized<SettingRow>;
/** 经 JSON 下发的字段：设置行上的带 session 声明，插件配置与页面动作的不一定带 */
export type Field = Localized<WireSchemaField>;

/** 可按会话覆盖的顶层字段（schema-config 的 isSessionField，按线上的形状收窄） */
export const isSessionEntry = (entry: unknown): entry is Field & { session: NonNullable<Field['session']> } =>
  isSessionField(entry);

/**
 * 一个可选项：key 用来比较，也是选择器里选项的值；value 是写回去的取值；isDefault 是可选项接口标的默认那一项；
 * description 是写在选项下面的一行说明；capabilities 是模型的能力（如 chat、vision），只有模型的可选项有
 */
export interface Option {
  key: string;
  label: string;
  value: unknown;
  isDefault?: boolean;
  description?: string;
  capabilities?: string[];
}

export const isModelField = (field: Field) => String(field.type) === 'llm-ref';

/** 选项在列表里的写法：可选项接口标了默认的那一项注明是默认 */
export const optionLabel = (option: Option) =>
  option.isDefault ? tr('optionDefault', { label: option.label }) : option.label;

/**
 * 一行没有生效值时写的一句：声明给的「没设时」，全局层由服务偏好承担的项（global 为真时）写跟随全局偏好；声明字段的插件给了
 * 此刻实际在用的值时另写它（「跟随服务偏好（此刻：<模型名>）」）
 */
export function unsetOf(row: Row, global = false): string | undefined {
  const unset =
    global && row.field.session.preference !== undefined ? tr('followGlobalPreference') : row.field.session.unset;
  const now = row.actual && (row.actual.label ?? formatValue(row.field, row.actual.value));
  return now === undefined ? unset : tr('unsetNow', { unset: unset ?? '', now });
}

/** 可选项依赖的另一项：它的名字，与它的取值写成的可选项接口的 dependency（没有取值时没有） */
export interface Dependency {
  label: string;
  value?: string;
}

/** 取值写成可选项接口的 dependency：模型写条目 id `<提供者实例 id>/<模型 id>`，文字原样，其余写 JSON */
export function dependencyText(field: Field, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const model = isModelField(field) ? modelOf(value) : undefined;
  if (model) return `${model.provider}/${model.model}`;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 一行可选项依赖的那一行（同一实例里的 dependsOn）：取它的生效值，没有时取它此刻实际在用的值；那一行不在这一组里时没有 */
export function dependencyOf(rows: readonly Row[], row: Row): Dependency | undefined {
  const key = row.field.session.dependsOn;
  const other = rows.find(candidate => candidate.plugin === row.plugin && candidate.key === key);
  return (
    other && { label: other.field.label, value: dependencyText(other.field, other.effective ?? other.actual?.value) }
  );
}

/** 能从一组选项里选的字段 */
export const hasChoices = (field: Field) => isModelField(field) || field.type === 'select' || field.type === 'boolean';

const modelOf = (value: unknown) =>
  isRecord(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    ? { provider: value.provider, model: value.model }
    : undefined;

export function valueKey(field: Field, value: unknown): string {
  const model = isModelField(field) ? modelOf(value) : undefined;
  return model ? `${model.provider}\n${model.model}` : typeof value === 'string' ? value : JSON.stringify(value);
}

/** 字段自己的选项：静态的 options，开关是开与关 */
export function staticOptions(field: Field): Option[] {
  if (field.type === 'boolean') {
    return [
      { key: 'true', label: tr('switchOn'), value: true },
      { key: 'false', label: tr('switchOff'), value: false },
    ];
  }
  return (field.options ?? []).map(option => ({ key: String(option.value), label: option.label, value: option.value }));
}

/** 可选项接口另给的 labels：认得、但这次不在可选项里的取值的名字（如别的模型才有的思考档位）；不是可选项 */
export function parseNames(body: unknown): Option[] {
  const labels = isRecord(body) && isRecord(body.labels) ? body.labels : {};
  return Object.entries(labels).flatMap(([value, label]) =>
    typeof label === 'string' ? [{ key: value, label, value }] : [],
  );
}

/**
 * 可选项接口（/api/models/:service）的回应：模型服务给 providers（每个模型带提供它的插件实例 id，即 contextId，与它的能力），分组等给 details
 * （标了 default 的是没设时生效的那一项），其余给 models 的名字列表
 */
export function parseOptions(models: boolean, body: unknown): Option[] {
  if (!isRecord(body)) throw new Error(tr('optionsMalformed'));
  const list = (key: string) => (Array.isArray(body[key]) ? (body[key] as unknown[]).filter(isRecord) : undefined);
  if (models) {
    const entries = (list('providers') ?? []).flatMap(entry => {
      const model = modelOf({ provider: entry.contextId, model: entry.model });
      const capabilities = Array.isArray(entry.capabilities)
        ? entry.capabilities.filter(item => typeof item === 'string')
        : [];
      return model
        ? [{ ...model, label: typeof entry.provider === 'string' ? entry.provider : model.provider, capabilities }]
        : [];
    });
    const repeated = (name: string) => entries.filter(m => m.model === name).length > 1;
    return entries.map(({ provider, model, label, capabilities }) => ({
      key: `${provider}\n${model}`,
      label: repeated(model) ? tr('modelWithProvider', { model, provider: label }) : model,
      value: { provider, model },
      capabilities,
    }));
  }
  const details = list('details');
  if (details) {
    return details.flatMap(entry =>
      typeof entry.value === 'string'
        ? [
            {
              key: entry.value,
              label: typeof entry.label === 'string' ? entry.label : entry.value,
              value: entry.value,
              ...(entry.default === true ? { isDefault: true } : {}),
              ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
            },
          ]
        : [],
    );
  }
  const names = Array.isArray(body.models) ? body.models.filter(name => typeof name === 'string') : [];
  return names.map(name => ({ key: name, label: name, value: name }));
}

/** 两个取值一样没有：空串与没填算一样，值为 undefined 的键当作没有（JSON 丢掉它们） */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b || ((a === '' || a === undefined) && (b === '' || b === undefined))) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = (value: Record<string, unknown>) => Object.keys(value).filter(key => value[key] !== undefined);
    return keys(a).length === keys(b).length && keys(a).every(key => sameValue(a[key], b[key]));
  }
  return false;
}

/**
 * 作者默认的说法，插件详情的配置表与设置的全局层共用这一处：取值等于作者默认（没有取值按作者默认算）时 isDefault；不等时 note
 * 是「默认：<作者默认>」。没有作者默认的项：没设时 isDefault，note 是「不设时：<没设时的含义>」；设了时 note 是「默认：不设」。
 * 密钥字段不写作者默认；必填又没有作者默认的项没有可回去的默认，也不写
 */
export function authorDefault(field: Field, value: unknown): { isDefault: boolean; note?: string } | undefined {
  if (field.secret === true) return undefined;
  if (field.default === undefined) {
    if (field.required) return undefined;
    if (value !== undefined) return { isDefault: false, note: tr('defaultIs', { value: tr('defaultNone') }) };
    const unset = field.session?.unset;
    return { isDefault: true, note: unset === undefined ? undefined : tr('unsetIs', { unset }) };
  }
  if (value === undefined || sameValue(value, field.default)) return { isDefault: true };
  return { isDefault: false, note: tr('defaultIs', { value: formatValue(field, field.default) }) };
}

/**
 * 取值写成一句：开关写开或关，选项写选项名，模型写模型名，列表与映射的各项按界面的语言连起来；空列表、空映射与不在选项里的
 * 空文字写「无」
 */
export function formatValue(field: Field, value: unknown, options: readonly Option[] = staticOptions(field)): string {
  const labelOf = (item: unknown) => options.find(option => option.key === valueKey(field, item))?.label;
  const list = (items: string[]) => (items.length > 0 ? listText(items) : tr('emptyValue'));
  if (isModelField(field)) return modelOf(value)?.model ?? JSON.stringify(value);
  if (Array.isArray(value)) return list(value.map(item => labelOf(item) ?? String(item)));
  if (field.type === 'map' && isRecord(value)) {
    return list(Object.entries(value).map(([key, item]) => `${key}=${String(item)}`));
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return labelOf(value) ?? (value === '' ? tr('emptyValue') : String(value));
  }
  return JSON.stringify(value);
}

const unlisted = (field: Field, options: readonly Option[], value: unknown): Option => ({
  key: valueKey(field, value),
  label: formatValue(field, value, options),
  value,
});

/** 当前值不在选项里（服务不在了、手写的值）时也列出来，免得看起来像选了别的；names 是不在选项里的取值的名字 */
export function withCurrent(
  field: Field,
  options: Option[],
  current: unknown,
  names: readonly Option[] = [],
): Option[] {
  if (current === undefined || options.some(option => option.key === valueKey(field, current))) return options;
  return [unlisted(field, [...options, ...names], current), ...options];
}

/** 多选：已选的值不在选项里时接在后面列出来 */
export function withChosen(field: Field, options: Option[], chosen: readonly unknown[]): Option[] {
  const known = new Set(options.map(option => option.key));
  return [
    ...options,
    ...chosen.filter(item => !known.has(valueKey(field, item))).map(item => unlisted(field, options, item)),
  ];
}

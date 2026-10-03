import type { SettingRow } from '@aalis/api-session-protocol';
import { isRecord } from '../rest';

// 设置项与页面动作输入的字段（schema-config 的词汇）：取值写成一句、选项的键，以及可选项接口回应的解析。前端不认识任何
// 设置键，只按字段类型渲染；模型字段（llm-ref）的取值是 { provider, model }，可选项来自模型服务

export type Field = SettingRow['field'];

/** 一个可选项：key 用来比较与做 <option> 的值，value 是写回去的取值；isDefault 是可选项接口标的默认那一项 */
export interface Option {
  key: string;
  label: string;
  value: unknown;
  isDefault?: boolean;
}

export const isModelField = (field: Field) => String(field.type) === 'llm-ref';

/** 一行的生效值：哪一层都没设时按字段的默认值 */
export const effectiveOf = (row: SettingRow) => (row.source === undefined ? row.field.default : row.effective);

/** 可选项依赖的另一项（设置项的 dependsOn）：它的名字与生效值 */
export interface Dependency {
  label: string;
  value: unknown;
}

/** 一行可选项依赖的那一行；那一行不在这一组里时没有 */
export function dependencyOf(rows: readonly SettingRow[], row: SettingRow): Dependency | undefined {
  const other = row.dependsOn === undefined ? undefined : rows.find(candidate => candidate.key === row.dependsOn);
  return other && { label: other.field.label, value: effectiveOf(other) };
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
      { key: 'true', label: '开', value: true },
      { key: 'false', label: '关', value: false },
    ];
  }
  return (field.options ?? []).map(option => ({ key: String(option.value), label: option.label, value: option.value }));
}

/**
 * 可选项接口（/api/models/:service）的回应：模型服务给 providers（每个模型带提供它的插件实例 id，即 contextId），分组等给 details
 * （标了 default 的是没设时生效的那一项），其余给 models 的名字列表
 */
export function parseOptions(models: boolean, body: unknown): Option[] {
  if (!isRecord(body)) throw new Error('可选项的回应不是预期的形状');
  const list = (key: string) => (Array.isArray(body[key]) ? (body[key] as unknown[]).filter(isRecord) : undefined);
  if (models) {
    const entries = (list('providers') ?? []).flatMap(entry => {
      const model = modelOf({ provider: entry.contextId, model: entry.model });
      return model ? [{ ...model, label: typeof entry.provider === 'string' ? entry.provider : model.provider }] : [];
    });
    const repeated = (name: string) => entries.filter(m => m.model === name).length > 1;
    return entries.map(({ provider, model, label }) => ({
      key: `${provider}\n${model}`,
      label: repeated(model) ? `${model}（${label}）` : model,
      value: { provider, model },
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
            },
          ]
        : [],
    );
  }
  const names = Array.isArray(body.models) ? body.models.filter(name => typeof name === 'string') : [];
  return names.map(name => ({ key: name, label: name, value: name }));
}

/** 取值写成一句：开关写开或关，选项写选项名，模型写模型名，列表用顿号连起来 */
export function formatValue(field: Field, value: unknown, options: readonly Option[] = staticOptions(field)): string {
  const labelOf = (item: unknown) => options.find(option => option.key === valueKey(field, item))?.label;
  if (isModelField(field)) return modelOf(value)?.model ?? JSON.stringify(value);
  if (Array.isArray(value)) return value.map(item => labelOf(item) ?? String(item)).join('、');
  if (field.type === 'map' && isRecord(value)) {
    return Object.entries(value)
      .map(([key, item]) => `${key}=${String(item)}`)
      .join('、');
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return labelOf(value) ?? String(value);
  }
  return JSON.stringify(value);
}

const unlisted = (field: Field, options: readonly Option[], value: unknown): Option => ({
  key: valueKey(field, value),
  label: formatValue(field, value, options),
  value,
});

/** 当前值不在选项里（服务不在了、手写的值）时也列出来，免得看起来像选了别的 */
export function withCurrent(field: Field, options: Option[], current: unknown): Option[] {
  if (current === undefined || options.some(option => option.key === valueKey(field, current))) return options;
  return [unlisted(field, options, current), ...options];
}

/** 多选：已选的值不在选项里时接在后面列出来 */
export function withChosen(field: Field, options: Option[], chosen: readonly unknown[]): Option[] {
  const known = new Set(options.map(option => option.key));
  return [
    ...options,
    ...chosen.filter(item => !known.has(valueKey(field, item))).map(item => unlisted(field, options, item)),
  ];
}

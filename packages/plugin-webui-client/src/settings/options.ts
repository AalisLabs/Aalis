import { useJson } from '../rest';
import {
  type Field,
  isModelField,
  type Option,
  type Others,
  parseNames,
  parseOptions,
  parseOthers,
  staticOptions,
} from './field';

// 字段的可选项：静态选项在前，动态来源（dynamicOptions 指向的服务，模型字段是模型服务）的接在后面，重复的不再列。
// 可选项依赖另一项的（设置项的 dependsOn），取的时候带上那一项的取值写成的 dependency（field.ts 的 dependencyText）

function sourceOf(field: Field, dependency: string | undefined): string | undefined {
  const path = isModelField(field)
    ? '/api/models/llm'
    : field.dynamicOptions === undefined
      ? undefined
      : `/api/models/${encodeURIComponent(field.dynamicOptions)}`;
  return path === undefined || dependency === undefined ? path : `${path}?dependency=${encodeURIComponent(dependency)}`;
}

const parseModelOptions = (body: unknown) => ({ options: parseOptions(true, body), names: [], others: undefined });
const parseOtherOptions = (body: unknown) => ({
  options: parseOptions(false, body),
  names: parseNames(body),
  others: parseOthers(body),
});

/**
 * version 变了重取（模型服务重新探测之后），dependency（可选项依赖的那一项的取值写成的文字）变了也重取。loaded：没有动态来源，
 * 或动态可选项已经取到。names 是来源另给的、不在可选项里的取值的名字，只用来显示；others 是来源另给的、不属于任何可选项的
 * 成员，写在可选项末尾
 */
export function useFieldOptions(
  field: Field,
  version = 0,
  dependency?: string,
): { options: Option[]; names: Option[]; others?: Others; loaded: boolean; error?: Error } {
  const source = sourceOf(field, dependency);
  const fetched = useJson(source, isModelField(field) ? parseModelOptions : parseOtherOptions, version);
  const own = staticOptions(field);
  const dynamic = fetched.value?.options ?? [];
  return {
    options: [...own, ...dynamic.filter(option => !own.some(existing => existing.key === option.key))],
    names: fetched.value?.names ?? [],
    others: fetched.value?.others,
    loaded: source === undefined || fetched.value !== undefined,
    error: fetched.error,
  };
}

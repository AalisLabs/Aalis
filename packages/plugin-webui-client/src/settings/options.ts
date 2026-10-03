import { useJson } from '../rest';
import { type Field, isModelField, type Option, parseOptions, staticOptions } from './field';

// 字段的可选项：静态选项在前，动态来源（dynamicOptions 指向的服务，模型字段是模型服务）的接在后面，重复的不再列。
// 可选项依赖另一项的（设置项的 dependsOn），取的时候带上那一项的生效值

function sourceOf(field: Field, dependency: unknown): string | undefined {
  const path = isModelField(field)
    ? '/api/models/llm'
    : field.dynamicOptions === undefined
      ? undefined
      : `/api/models/${encodeURIComponent(field.dynamicOptions)}`;
  return path === undefined || dependency === undefined
    ? path
    : `${path}?dependency=${encodeURIComponent(JSON.stringify(dependency))}`;
}

const parseModelOptions = (body: unknown) => parseOptions(true, body);
const parseOtherOptions = (body: unknown) => parseOptions(false, body);

/**
 * version 变了重取（模型服务重新探测之后），dependency（可选项依赖的那一项的生效值）变了也重取。loaded：没有动态来源，
 * 或动态可选项已经取到
 */
export function useFieldOptions(
  field: Field,
  version = 0,
  dependency?: unknown,
): { options: Option[]; loaded: boolean; error?: Error } {
  const source = sourceOf(field, dependency);
  const fetched = useJson(source, isModelField(field) ? parseModelOptions : parseOtherOptions, version);
  const own = staticOptions(field);
  const dynamic = fetched.value ?? [];
  return {
    options: [...own, ...dynamic.filter(option => !own.some(existing => existing.key === option.key))],
    loaded: source === undefined || fetched.value !== undefined,
    error: fetched.error,
  };
}

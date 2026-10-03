import { useJson } from '../rest';
import { type Field, isModelField, type Option, parseOptions, staticOptions } from './field';

// 字段的可选项：静态选项在前，动态来源（dynamicOptions 指向的服务，模型字段是模型服务）的接在后面，重复的不再列

/** 模型字段的可选项来源：模型服务 */
const MODEL_OPTIONS = '/api/models/llm';

function sourceOf(field: Field): string | undefined {
  if (isModelField(field)) return MODEL_OPTIONS;
  return field.dynamicOptions === undefined ? undefined : `/api/models/${encodeURIComponent(field.dynamicOptions)}`;
}

const parseModelOptions = (body: unknown) => parseOptions(true, body);
const parseOtherOptions = (body: unknown) => parseOptions(false, body);

export function useFieldOptions(field: Field): { options: Option[]; error?: Error } {
  const source = sourceOf(field);
  const fetched = useJson(source, source === MODEL_OPTIONS ? parseModelOptions : parseOtherOptions, 0);
  const own = staticOptions(field);
  const dynamic = fetched.value ?? [];
  return {
    options: [...own, ...dynamic.filter(option => !own.some(existing => existing.key === option.key))],
    error: fetched.error,
  };
}

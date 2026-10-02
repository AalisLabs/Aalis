import { useEffect, useState } from 'react';
import { getJson } from '../rest';
import { type Field, isModelField, type Option, parseOptions, staticOptions } from './field';

// 字段的可选项：静态选项在前，动态来源（dynamicOptions 指向的服务，模型字段是模型服务）的接在后面，重复的不再列

/** 模型字段的可选项来源：模型服务 */
const MODEL_OPTIONS = '/api/models/llm';

function sourceOf(field: Field): string | undefined {
  if (isModelField(field)) return MODEL_OPTIONS;
  return field.dynamicOptions === undefined ? undefined : `/api/models/${encodeURIComponent(field.dynamicOptions)}`;
}

export function useFieldOptions(field: Field): { options: Option[]; error?: Error } {
  const source = sourceOf(field);
  const [fetched, setFetched] = useState<{ source?: string; options: Option[]; error?: Error }>({ options: [] });

  useEffect(() => {
    if (source === undefined) return;
    const controller = new AbortController();
    getJson(source, controller.signal)
      .then(body => parseOptions(source === MODEL_OPTIONS, body))
      .then(
        options => setFetched({ source, options }),
        (error: Error) => {
          if (!controller.signal.aborted) setFetched({ source, options: [], error });
        },
      );
    return () => controller.abort();
  }, [source]);

  const own = staticOptions(field);
  const dynamic = fetched.source === source ? fetched.options : [];
  return {
    options: [...own, ...dynamic.filter(option => !own.some(existing => existing.key === option.key))],
    error: fetched.source === source ? fetched.error : undefined,
  };
}

// ════════════════════════════════════════════════════════════
// 指令的文字读写：文字读成取值（/session.set 与父会话改子会话设置的工具），取值写成回执里的文字。只有本插件的指令用，不导出。
// 读：boolean 收 true、false、on、off、1、0，number 收数字，select 有静态可选项时只收选项值（不收选项标签），multiselect 与
// list 按逗号或顿号拆，string、textarea 原样，外来类型调字段的 fromText（没有时回不合法），map 不支持。
// 写：select 写选项标签，开关写开或关，列表按界面语言连起来，外来类型调 toText，其余写成文字。
// ════════════════════════════════════════════════════════════

import type { SchemaField } from '@aalis/schema-config';
import type { TextRef } from '@aalis/schema-i18n';
import { t } from './texts.js';

const TRUE = new Set(['true', 'on', '1']);
const FALSE = new Set(['false', 'off', '0']);

/** 取值只能是静态可选项之一 */
export const fixedChoices = (field: SchemaField): readonly string[] | undefined =>
  field.options && field.dynamicOptions === undefined && field.allowCustom !== true
    ? field.options.map(option => String(option.value))
    : undefined;

/** 文字读成取值；读不出时给出原因 */
export function readText(field: SchemaField, text: string): { value: unknown } | { invalid: TextRef } {
  const trimmed = text.trim();
  switch (field.type) {
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (TRUE.has(lower)) return { value: true };
      return FALSE.has(lower) ? { value: false } : { invalid: t('notBoolean') };
    }
    case 'number': {
      const number = Number(trimmed);
      return trimmed !== '' && Number.isFinite(number) ? { value: number } : { invalid: t('notNumber') };
    }
    case 'select': {
      const choices = fixedChoices(field);
      if (!choices) return { value: trimmed };
      const option = field.options?.find(o => String(o.value) === trimmed);
      return option ? { value: option.value } : { invalid: t('notChoice') };
    }
    case 'multiselect':
    case 'list':
      return {
        value: trimmed
          .split(/[,，、]/)
          .map(part => part.trim())
          .filter(part => part !== ''),
      };
    case 'string':
    case 'textarea':
      return { value: text };
    case 'map':
      return { invalid: t('mapUnsupported') };
    default: {
      if (typeof field.fromText !== 'function') return { invalid: t('noTextForm') };
      try {
        const value = field.fromText(trimmed);
        return value === undefined ? { invalid: t('unreadable') } : { value };
      } catch {
        return { invalid: t('unreadable') };
      }
    }
  }
}

/** 取值写成回执里的文字 */
export function writeText(field: SchemaField, value: unknown): string | TextRef {
  if (field.type === 'select') {
    return field.options?.find(o => String(o.value) === String(value))?.label ?? String(value);
  }
  if (field.type === 'boolean') return value === true ? t('on') : t('off');
  if (Array.isArray(value)) return value.length > 0 ? t('listValue', { items: value.map(String) }) : t('emptyList');
  if (typeof field.toText === 'function') {
    // 严格字段的坏值原样交到这里，toText 认不得时按原样写
    try {
      return field.toText(value);
    } catch {
      return JSON.stringify(value);
    }
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

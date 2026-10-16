// ============================================================
// failure.ts — 插件失败给人看的说明
//
// core 只存失败的原值（PluginStatusEntry.failure）与它的摘要（error），不碰字典。说明在这里按原值现取：挂了文字对象的错误
// 取它，core 自己的失败按 code 给本包字典的说明，其余用 core 的摘要。出口只交出这里给的说明，不下发原值。
// ============================================================

import type { CoreFailureCode, PluginStatusEntry } from '@aalis/core';
import { isTextError, type TextRef } from '@aalis/schema-i18n';
import { t } from './texts.js';

/** core 自己的失败挂的数据属性（各 code 带哪几项见 core 的 CoreFailureCode） */
interface FailureData {
  service?: unknown;
  services?: unknown;
  provider?: unknown;
}

const CORE_FAILURES: { readonly [C in CoreFailureCode]: (data: FailureData) => TextRef } = {
  'required-retry-exhausted': ({ service }) => t('retryExhausted', { service: String(service) }),
  'provides-not-registered': ({ services }) =>
    t('providesNotRegistered', { services: Array.isArray(services) ? services.map(String) : [] }),
  'exclusive-conflict': ({ service }) => t('exclusiveConflict', { service: String(service) }),
  'service-unavailable': ({ service, provider }) =>
    provider === undefined
      ? t('unavailable', { service: String(service) })
      : t('unavailableFrom', { service: String(service), provider: String(provider) }),
};

/** core 自己的失败按 code 给说明（code 与数据属性见 core 的 CoreFailureCode）；不是 core 的 code、没有失败时 undefined */
function describeFailure({ failure }: Pick<PluginStatusEntry, 'failure'>): TextRef | undefined {
  if (typeof failure !== 'object' || failure === null) return undefined;
  const { code } = failure as { code?: unknown };
  return typeof code === 'string' && Object.hasOwn(CORE_FAILURES, code)
    ? CORE_FAILURES[code as CoreFailureCode](failure)
    : undefined;
}

/**
 * 插件失败给人看的说明：挂了文字对象的错误（TextError、configError 等）取它，core 自己的失败按 code 给本包字典的说明，
 * 其余用 core 的摘要 error。没有失败时 undefined
 */
export function failureText(entry: Pick<PluginStatusEntry, 'failure' | 'error'>): string | TextRef | undefined {
  return isTextError(entry.failure) ? entry.failure.text : (describeFailure(entry) ?? entry.error);
}

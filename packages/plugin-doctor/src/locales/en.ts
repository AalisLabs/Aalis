import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  pluginLine: '{instance}: {reason}',
  reportTitle: '**System diagnostics — {at, datetime, medium}**',
  reportSummary: 'Summary: ✓ {ok, number}  ! {warn, number}  ✗ {error, number}',
  reportErrors: '__✗ Errors__',
  reportWarnings: '__! Warnings__',
  reportPassed: '__✓ Passed__',
  reportCheck: '- {check, code} — {message}',
  reportDetail: '    {detail}',
});

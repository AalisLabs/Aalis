import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  pluginLine: '{instance}: {reason}',
  reportTitle: '**System diagnostics — {at, datetime, medium}**',
  reportSummary: 'Summary: passed {ok, number}  warnings {warn, number}  errors {error, number}',
  reportErrors: '__Errors__',
  reportWarnings: '__Warnings__',
  reportPassed: '__Passed__',
  reportCheck: '- {check, code} — {message}',
  reportDetail: '    {detail}',
});

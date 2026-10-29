import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Message archive',
  debugLogsLabel: 'Archive debug logs',
  debugLogsDescription: 'Log debug lines such as image descriptions completing and messages being written to memory.',
});

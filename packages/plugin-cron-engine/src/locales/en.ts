import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Cron scheduling engine',
  badTimeZone: 'Invalid time zone: {timeZone}',
});

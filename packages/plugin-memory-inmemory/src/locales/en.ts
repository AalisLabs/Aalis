import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'In-process memory',
  rangeQueryLimitLabel: 'Range query limit',
  rangeQueryLimitDescription:
    'Maximum messages returned by one range query. Results beyond the limit are cut off silently (same as the sqlite/mongodb backends)',
  crossSessionMaxLimitLabel: 'Cross-session query limit',
  crossSessionMaxLimitDescription:
    'Maximum messages a cross-session recent-messages query may return; larger requests are narrowed to this limit',
});

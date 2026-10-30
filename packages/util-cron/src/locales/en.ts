import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  empty: 'The expression is empty',
  every: 'Unrecognized @every expression: {expr}',
  interval: 'The interval must be greater than 0 and at most {max, number} seconds (about 24.8 days): {value}',
  syntax: 'Invalid cron expression (needs 5 fields or an alias): {expr}',
  field: 'Cron field {field, number} is invalid (parses to nothing): “{value}”',
});

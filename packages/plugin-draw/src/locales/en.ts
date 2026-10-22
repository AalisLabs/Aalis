import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  cleared: 'Drawings cleared ({count, plural, one {# file} other {# files}})',
  clearFailed: 'Failed to clear drawings: {error}',
});

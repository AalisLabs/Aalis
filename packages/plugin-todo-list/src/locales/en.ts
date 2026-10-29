import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Task plan',
  groupSummary: 'Create and manage task plan lists, breaking complex tasks down and tracking progress',
  enabledLabel: 'Enable the task plan tool',
  clearedAll: 'Cleared the to-do lists of all sessions ({count, plural, one {# session} other {# sessions}})',
  clearedSession: 'Cleared the to-do list of this session',
  clearFailed: 'Clearing to-do lists failed: {error}',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  instanceLabel: '{name} ({instance})',
  notApplicable:
    'Session setting {key} does not apply to {kind, select, owner {my sessions} room {rooms} task {subtasks} other {{kind}}}',
  toolLimit: 'Tool calls reached the limit for this turn; you can let the assistant continue',
  compacting: 'Compacting the conversation',
  compacted: 'Conversation compacted',
  compactionFailed: 'Compaction failed',
});

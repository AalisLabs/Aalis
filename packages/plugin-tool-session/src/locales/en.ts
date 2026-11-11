import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Session tools',
  sessionHistory: 'Session history reading',
  groupSummary: 'Read recent session history by Aalis sessionId to verify cross-session context',
  enabledLabel: 'Enable the session history reading tool',
  maxLimitLabel: 'Max messages per read',
  maxLimitDescription:
    'Most messages a single history read returns; larger requests from the model are capped to it. 50 to 200 is recommended.',
  defaultLimitLabel: 'Default messages per read',
  defaultLimitDescription:
    'Used when the model gives no limit; cannot exceed “Max messages per read”. Raising it gives the model more context but costs more tokens.',
  includeArchivedDefaultLabel: 'Include archived messages by default',
  perMessageMaxCharsLabel: 'Per-message truncation length',
  perMessageMaxCharsDescription:
    'Character limit of each history message returned to the model; 0 = no truncation (recommended). Anything beyond it is cut off, ending with “…[已截断，还剩 N 个字符未展示]”.',
});

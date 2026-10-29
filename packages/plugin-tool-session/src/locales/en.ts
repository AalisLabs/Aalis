import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Session tools',
  sessionHistory: 'Session history reading',
  groupSummary: 'Read recent session history by Aalis sessionId to verify cross-session context',
  enabledLabel: 'Enable the session history reading tool',
  maxLimitLabel: 'Max messages per read',
  maxLimitDescription:
    'Hard upper limit of what session_get_history can return at once; a limit above it passed by the LLM is capped. 50 to 200 is recommended.',
  defaultLimitLabel: 'Default messages per read (when the LLM passes no limit)',
  defaultLimitDescription:
    'Cannot exceed maxLimit. Raising it lets the agent passively get more context, at the cost of token budget.',
  includeArchivedDefaultLabel: 'Include archived messages by default',
  perMessageMaxCharsLabel: 'Per-message truncation length',
  perMessageMaxCharsDescription:
    'Character limit of each history message returned to the LLM; 0 = no truncation (recommended). Anything beyond it is cut off with a note of how many characters were not shown.',
});

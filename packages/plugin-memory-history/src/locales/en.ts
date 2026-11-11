import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Cross-session history context',
  injectEnabledLabel: 'Inject into the prompt',
  injectEnabledDescription:
    'Automatically inject recent cross-session messages before every model call. When off, the tool still works (if “Register the recent_messages tool” is on).',
  limitLabel: 'Injected message limit',
  limitDescription: 'Maximum messages per injection; also used when a tool call does not specify limit.',
  maxAgeMinutesLabel: 'Time window (minutes)',
  maxAgeMinutesDescription: 'Only take messages from the last N minutes; 0 means no time limit.',
  perSessionLimitLabel: 'Max messages per session',
  perSessionLimitDescription:
    'At most N messages from each session, so one busy group cannot fill the injected message limit. 0 = no limit.',
  excludeCurrentSessionLabel: 'Exclude the current session',
  excludeCurrentSessionDescription:
    'Exclude the current session when injecting and querying, so it does not repeat the session history the chat agent already reads.',
  headerTextLabel: 'Injected header text',
  headerTextDescription: 'The explanatory text at the start of the injected block.',
  toolEnabledLabel: 'Register the recent_messages tool',
  toolEnabledDescription:
    'Whether to register the recent_messages tool so the agent can look up recent cross-session messages on demand.',
});

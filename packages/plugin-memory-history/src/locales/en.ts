import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Cross-session history context',
  injectEnabledLabel: 'Inject into the prompt',
  injectEnabledDescription:
    'Whether to inject recent cross-session messages as a system block before every LLM call. When off, the tool still works (requires toolEnabled=true).',
  limitLabel: 'Injected message limit',
  limitDescription: 'Maximum messages per injection; also used when a tool call does not specify limit.',
  maxAgeMinutesLabel: 'Time window (minutes)',
  maxAgeMinutesDescription: 'Only take messages from the last N minutes; 0 means no time limit.',
  perSessionLimitLabel: 'Max messages per session',
  perSessionLimitDescription:
    'Keep at most N messages from the same sessionId, so one busy group cannot fill the whole limit; 0 = no per-session cap.',
  excludeCurrentSessionLabel: 'Exclude the current session',
  excludeCurrentSessionDescription:
    "Exclude the current sessionId when injecting (so it does not repeat this session's history, which the chat agent reads by the historyLimit session setting).",
  headerTextLabel: 'Injected header text',
  headerTextDescription: 'The explanatory text at the start of the system message injected into messages[].',
  toolEnabledLabel: 'Register the recent_messages tool',
  toolEnabledDescription:
    'Whether to register the recent_messages tool so the agent can look up recent cross-session messages on demand.',
});

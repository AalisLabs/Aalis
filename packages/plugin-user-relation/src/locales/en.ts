import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  recallScopeLabel: 'Relation graph scope',
  recallScopeDescription:
    'Which sessions’ events the injected relation graph and the relation graph tools draw on: with this session only, the injection leaves out events extracted in other sessions, cross-session topics and global trends while relationships between people stay, and the tools’ session scope can only be this session. An invalid value counts as this session only',
  recallScopeSession: 'This session only',
  recallScopeAll: 'All',
  clearType: 'User relation graph (across sessions)',
  clearSkipped:
    'The relation graph is cross-session data and is cleared only when clearing all sessions, so it was not cleared this time',
});

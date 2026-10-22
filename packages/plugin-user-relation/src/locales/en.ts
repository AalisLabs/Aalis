import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  recallScopeLabel: 'Relation graph scope',
  recallScopeDescription:
    'Which sessions’ events the injected relation graph draws on: with this session only, events extracted in other sessions, cross-session topics and global trends are left out, while relationships between people stay. An invalid value counts as this session only',
  recallScopeSession: 'This session only',
  recallScopeAll: 'All',
});

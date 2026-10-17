import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  recallScopeLabel: 'Memory recall scope',
  recallScopeDescription:
    "Where cross-session memory and history are drawn from; it can only be narrower than each memory plugin's own configuration, and a wider value falls back to the plugin configuration",
  recallScopeSession: 'This session only',
  recallScopePlatform: 'Same platform',
  recallScopeAll: 'All',
  recallScopeUnset: 'As each memory plugin is configured',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Message gateway',
  agentUnavailable: '[System] The agent service is unavailable; check the plugin configuration.',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  restarted: 'Still running when Aalis restarted',
  closed: 'Still running when the tool registry was disabled',
  withdrawn: 'Tool {name} was unregistered',
});

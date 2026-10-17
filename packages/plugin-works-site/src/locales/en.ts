import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  withdrawn: 'Withdrawn',
  withdrawnDegraded: 'Withdrawal registered; site status: {state}',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Message flow control',
  cooldownSecondsLabel: 'Cooldown after a reply (seconds)',
  rateLimitWindowLabel: 'Rate limit window (seconds, 0 = off)',
  rateLimitMaxRepliesLabel: 'Max replies within the window',
});

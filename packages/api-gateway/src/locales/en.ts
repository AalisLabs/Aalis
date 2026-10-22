import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  audienceLabel: 'Applies to',
  audienceDescription:
    'Which rooms this applies to: multi-party rooms are chat windows with more than two parties, such as groups and channels; one-to-one rooms are private chats. WebUI and terminal sessions are never covered',
  audienceOff: 'Off',
  audienceMultiParty: 'Multi-party rooms',
  audienceOneToOne: 'One-to-one rooms',
  audienceAll: 'All rooms',
});

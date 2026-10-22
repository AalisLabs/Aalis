import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  childrenDeleted: '{count, plural, one {Deleted # subsession} other {Deleted # subsessions}}',
});

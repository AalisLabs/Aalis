import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  notWritten:
    'Applied at runtime, but not written to the config file ({error}); {reconcile, select, reload {once the file is fixed, it is reloaded from its contents} other {once the file is fixed, its contents take effect at the next restart}}',
  writeFailed:
    'Applied at runtime, but writing the config file failed ({error}); the change stays in the document and is written with the next successful save',
});

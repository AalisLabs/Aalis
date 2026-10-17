import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  jobSaved: 'Saved job {name}',
  notPersisted:
    'only effective for this run, not written to {uri}: it could not be read; see Needs attention for how to fix it',
});

import { defineLocale } from '../../../../../packages/schema-i18n/src/index.js';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  brief: 'A short sentence. Details follow',
  long: 'A first sentence that keeps going well past the forty-eight column limit. Details follow',
});

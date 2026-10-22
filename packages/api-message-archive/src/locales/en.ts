import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  unaddressed: '[{kind}] {name}',
  unaddressedKind: '[{kind}]',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  file: 'File',
});

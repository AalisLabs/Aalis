import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  visionReady: 'Image recognition is available; recognition model: {model}',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  noSuchLevel: 'Model {model} has no thinking level “{level}”',
  badModelRef: 'must be an object with provider and model, both non-empty strings',
});

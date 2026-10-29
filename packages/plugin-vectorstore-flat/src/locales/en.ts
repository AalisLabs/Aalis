import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Flat vector store',
  pathLabel: 'Storage directory',
  pathDescription: 'Directory for the JSON vector file (storage URI). The old form “data/vectorstore” also works.',
});

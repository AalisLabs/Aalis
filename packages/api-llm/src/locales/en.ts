import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({ noSuchLevel: 'Model {model} has no thinking level “{level}”' });

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({ invalidValue: 'Invalid value for session setting {key}: {reason}' });

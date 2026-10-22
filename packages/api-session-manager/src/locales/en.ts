import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  defaultWorkspace: 'Default workspace',
  sessionName: 'Session {t, datetime, short}',
  subtaskName: 'Subtask {t, time, short}',
  takeUnknown: "The session's origin cannot be determined, so nothing is taken across sessions",
});

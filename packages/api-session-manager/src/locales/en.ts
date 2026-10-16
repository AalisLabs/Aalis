import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  layerDefaults: 'Global default',
  layerPlatform: 'Platform profile',
  layerType: 'Platform-type profile',
  layerPlace: 'Place',
  layerParent: 'Parent session',
  layerSession: 'This session',
  defaultWorkspace: 'Default workspace',
  sessionName: 'Session {t, datetime, short}',
  subtaskName: 'Subtask {t, time, short}',
});

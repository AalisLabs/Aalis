import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  layerGlobal: 'Global (plugin config)',
  layerPlatform: 'Platform profile',
  layerPlatformType: 'Platform-type profile',
  layerPlace: 'Place',
  layerSession: 'This session',
  settingsAbsent:
    'Session settings are unavailable (@aalis/plugin-session-settings is not installed or enabled, or the session manager is not running)',
});

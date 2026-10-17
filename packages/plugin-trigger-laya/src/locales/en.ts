import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  inactive:
    'Laya trigger judging is not in effect (the active trigger plugin is “{label}”), so the sidecar is not checked; to enable it, point trigger to @aalis/plugin-trigger-laya under servicePreferences in the configuration file',
  inactiveNone:
    'Laya trigger judging is not in effect (no trigger plugin is active), so the sidecar is not checked; to enable it, point trigger to @aalis/plugin-trigger-laya under servicePreferences in the configuration file',
});

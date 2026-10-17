import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  capabilityDenied: 'Disabled by the system: {capability}',
  levelTooLow: 'Insufficient permission: "{capability}" needs level {required} (current {level})',
  intentUnreachable:
    'Operation cancelled: {capability} needs confirmation from the sender in person, but this command was not typed by a person, so it cannot be confirmed',
  intentDeclined: 'Operation cancelled: {capability} was not confirmed by the sender',
  approvalsAbsent:
    'Operation cancelled: {capability} needs owner approval, but the approval service is absent (provided by @aalis/plugin-session-server)',
});

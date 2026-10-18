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
  confirmSession: 'Every time (the waiver list can waive it)',
  confirmAlways: 'Every time (only a confirmation override set to off waives it)',
  rulesDescription:
    'Disabling overrides everything, owners included. Waiving confirmation only applies to what is done as an owner: the owner in person, subtasks the owner dispatched, scheduled tasks the owner created, and workflows whose definer and caller are both owners; anything started by others still needs owner approval, and is refused where no approval can be raised. Neither lowers levels. Both accept wildcards, such as tool:*.',
  waivePattern:
    'A capability key or wildcard, such as tool:shell_exec, command:level, tool:*. Only waives confirmation for what is done as an owner; anything started by others still needs owner approval',
});

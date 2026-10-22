import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  instanceLabel: '{name} ({instance})',
  toolLimit: 'Tool calls reached the limit for this turn; you can let the assistant continue',
  compacting: 'Compacting the conversation',
  compacted: 'Conversation compacted',
  compactionFailed: 'Compaction failed',
  unsentSilent: 'Not sent: this turn ended silently',
  unsentAborted: 'Not sent: the turn was aborted',
  unsentError: 'Not sent: the turn failed',
  beforeToolUnsent: 'Not sent: what is said before calling a tool is not sent to the group',
  retried: 'Not sent: the format check failed, so the reply was retried',
  notAccepted: 'Not sent: the platform did not accept it ({error})',
  noAdapter: 'Not sent: no platform adapter took this message',
  sendFailed: 'Not sent: sending failed ({error})',
  responderNotOwner: 'The responder is not the owner',
  approvalSettled: 'This approval has already been settled',
  noSuchApproval: 'No such approval: {id}',
  contentHashMismatch: 'The content hash does not match',
});

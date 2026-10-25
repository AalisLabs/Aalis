import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  nodeFailed: 'Node "{id}" failed: {error}',
  statusPending: 'Pending',
  statusRunning: 'Running',
  statusSuccess: 'Succeeded',
  statusFailed: 'Failed',
  statusCancelled: 'Cancelled',
  runNotSucceeded: 'Run did not succeed ({status})',
  runNotSucceededBecause: 'Run did not succeed ({status}): {error}',
  cancelRun: 'Cancel run',
  cancelRunConfirm:
    'Cancel this run? Finished nodes are not undone, and a turn already dispatched by an agent node runs to completion; the record stays in the run history.',
  runCancelled: 'Cancelled {id}',
  runEnded: 'This run has already ended',
  interruptedByExit: 'Interrupted when the process exited',
  saved: 'Saved workflow {id}',
  enabled: 'Enabled {id}',
  disabled: 'Disabled {id}',
  onceSkipped:
    'reading the once ledger failed (see the log), so it will not trigger in this run; use {manualRun} to run it manually',
  onceSkippedPersisted:
    'reading the once ledger failed (see the log), so it will not trigger in this run; use {manualRun} to run it manually, and restart after fixing the run history file to restore it',
  runNow: '“Run now”',
  blockedEventTrigger:
    'The event trigger subscribes to {event}, whose payload carries session content (session IDs, platforms, message text and the like), so it cannot be a trigger source',
  definedBy: 'Defined by',
  anonymous: 'Anonymous',
});

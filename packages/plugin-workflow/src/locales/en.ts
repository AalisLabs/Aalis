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
  saved: 'Saved workflow {id}',
  enabled: 'Enabled {id}',
  disabled: 'Disabled {id}',
  onceSkipped:
    'reading the once ledger failed (see the log), so it will not trigger in this run; use {manualRun} to run it manually',
  onceSkippedPersisted:
    'reading the once ledger failed (see the log), so it will not trigger in this run; use {manualRun} to run it manually, and restart after fixing the run history file to restore it',
  runNow: '“Run now”',
  definedBy: 'Defined by',
  anonymous: 'Anonymous',
});

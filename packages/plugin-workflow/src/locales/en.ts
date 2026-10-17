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
});

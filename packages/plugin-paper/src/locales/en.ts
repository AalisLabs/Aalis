import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  notice: '[Paper] Task {id} “{name}” {outcome}.{took}{cost}',
  took: ' Took {ms, duration}.',
  cost: ' Cost {cents, plural, one {# cent} other {# cents}}.',
  costPending: ' The cost has not been booked yet.',
  outcomeDone: 'completed',
  outcomeUnpublished: 'was not published: {reason}',
  outcomeUnpublishedUnknown: 'was not published: publishing failed',
  outcomeFailed: 'failed: {error}',
  outcomeFailedUnknown: 'failed for an unknown reason',
  outcomeTimeout: 'exceeded the per-run time limit and was cancelled',
  outcomeOwnerCancelled: 'was cancelled by the owner',
  outcomeRemoteCancelled: 'was cancelled remotely',
  stateWithError: '{state}: {error}',
  publicationWithReason: '{target}: {state} ({reason})',
});

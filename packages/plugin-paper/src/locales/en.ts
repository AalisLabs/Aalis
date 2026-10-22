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
  paperEnabledLabel: 'Enable paper',
  paperEnabledDescription: 'Turn on the paper for this room',
  paperNameLabel: 'Paper name',
  paperNameDescription:
    'Leave empty to give each window its own paper with the attributes from the paper plugin’s defaults; windows that write the same name share one paper',
  remoteTypesLabel: 'Remote agent types',
  remoteTypesDescription: 'Allowed remote agent plugin instance ids; empty turns remote tasks off',
  userCentsLabel: 'Daily amount limit per person (cents)',
  userCentsDescription:
    'Leave empty for no extra per-person amount limit; 0 blocks new remote tasks; an invalid value counts as 0',
  userTasksLabel: 'Daily task limit per person',
  userTasksDescription: 'Leave empty for no per-person limit',
  userTasksUnset: 'No per-person limit',
  roomCentsLabel: 'Daily amount limit per room (cents)',
  roomCentsDescription:
    'Leave empty for no extra room amount limit; 0 blocks new remote tasks; an invalid value counts as 0',
  noExtraLimit: 'No extra limit',
});

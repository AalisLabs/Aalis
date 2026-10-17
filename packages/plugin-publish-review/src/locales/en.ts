import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  categorySexual: 'Sexual content',
  categoryViolence: 'Violence or gore',
  categoryHate: 'Hate or discrimination',
  categoryPolitical: 'Politically sensitive',
  categoryIllegal: 'Illegal',
  categoryPhishing: 'Phishing or impersonation',
  categoryPersonalInfo: 'Personal information',
  categoryHarassment: 'Harassment or targeting individuals',
  categoryOther: 'Other',
  reasons: '{items, list}',
  noticeAwaitingOwner:
    'The work is waiting for owner review, for up to {hours, plural, one {{hours} hour} other {{hours} hours}}; you will be notified again when there is a result',
  noticeRejected: 'The work was not approved and will not be published this time',
  noticeExpired:
    'The work waited for owner review for more than {hours, plural, one {{hours} hour} other {{hours} hours}} and will not be published this time; nominate it again if needed',
  noticeDelayed:
    'The work was approved for publishing, but the works site could not put it online for now; the owner will handle it, and you will be notified again once it is live',
  noticeIntegrityFailed:
    'The work passed review, but the file integrity check before going live failed, so it will not be published this time',
  noticeUnreviewable:
    'The work cannot be reviewed right now (the review step is unavailable), so it will not be published this time',
  noticeLive: 'The work is live: {addresses, list}',
  noticeFallback: '[Work notice] {notice}',
});

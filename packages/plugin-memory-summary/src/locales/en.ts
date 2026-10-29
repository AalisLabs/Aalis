import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  compacted: 'Conversation compacted',
  clearType: 'Session summaries',
  budgetRatioLabel: 'Summary budget (share of the auto-compaction threshold)',
  budgetRatioDescription:
    "When compacting, the summary together with the original messages kept verbatim comes to about this share of this session's auto-compaction threshold (taken from its latest usage), whatever triggered it, but no more than the content being compacted (the previous summary plus the newly compacted conversation); at least {min} tokens and at most a quarter of the threshold. The kept messages stay within this share of the newly compacted conversation (the previous summary is not counted, and the minimum does not apply). The final length is at most two thirds of the summary model's output limit (or a quarter of its context window, whichever is smaller); a longer summary needs a summary model with a larger output limit. Before any usage is known, it follows the content being compacted, likewise no less than the minimum and within this cap",
  compressAtLabel: 'Auto-compaction threshold (share of the context window)',
  compressAtDescription:
    'Compact when usage reaches this share of the context window; 0 turns off compaction by usage (the message-count threshold still applies)',
});

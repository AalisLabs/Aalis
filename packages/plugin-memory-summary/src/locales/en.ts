import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  compacted: 'Conversation compacted',
  clearType: 'Session summaries',
  budgetRatioLabel: 'Summary budget (share of the compacted content)',
  budgetRatioDescription:
    "When compacting, the summary together with the original messages kept verbatim comes to about this share of the input being rewritten (the previous summary plus the newly compacted conversation), so older content is condensed further each time. At least {min} tokens in total, of which the kept messages stay within this share of the newly compacted conversation (the previous summary is not counted, and the minimum does not apply); the summary model's output limit and context window, and this session's compaction threshold, cap it further",
  compressAtLabel: 'Auto-compaction threshold (share of the context window)',
  compressAtDescription:
    'Compact when usage reaches this share of the context window; 0 turns off compaction by usage (the message-count threshold still applies)',
});

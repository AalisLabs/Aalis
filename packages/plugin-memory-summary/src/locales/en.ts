import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  compacted: 'Conversation compacted',
  budgetRatioLabel: 'Summary budget (share of the compacted content)',
  budgetRatioDescription:
    "When compacting, the summary is about this share of the input being rewritten (the previous summary plus the newly compacted conversation), so older content is condensed further each time. At least {min} tokens; the summary model's output limit and context window, and this session's compaction threshold, cap it further",
});

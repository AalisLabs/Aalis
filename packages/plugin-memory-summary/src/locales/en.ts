import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  compacted: 'Conversation compacted',
  clearType: 'Session summaries',
  budgetRatioLabel: 'Summary budget',
  budgetRatioDescription:
    "Target length of the summary after compaction (including the kept original messages), as a share of this session's auto-compaction threshold. At least {min} tokens and at most a quarter of the threshold; see the docs for the other limits.",
  compressAtLabel: 'Auto-compaction threshold',
  compressAtDescription:
    'Compact when usage reaches this share of the context window; 0 turns off compaction by usage (the message-count threshold still applies)',
  displayName: 'Memory summary',
  compressionLabel: 'Session compaction',
  noChatModel: 'No chat model is available',
  modelFailed: 'The summary model call failed: {error}',
  outputTruncated: 'The summary model stopped at its output limit; the output is incomplete',
  emptySummary: 'The summary model returned empty content',
  windowTooSmall:
    "The summary model's context window ({contextLength}) cannot hold the prompt, the existing summary and the summary's output limit ({maxTokens})",
  clearedDuring: 'The session was cleared during compaction',
  historyChanged: 'The history changed during compaction',
  busy: 'This session is being compacted; try again later',
  noMemory: 'The memory service is unavailable',
  clearedAll: 'Cleared all session summaries',
  clearedSession: 'Cleared the summary of this session',
  clearFailed: 'Clearing summaries failed: {error}',
});

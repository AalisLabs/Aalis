import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Vector memory',
  searchLabel: 'Search settings',
  topKLabel: 'Max results',
  topKDescription: 'Number of hits a semantic search returns (each comes with its context window)',
  timeWeightLabel: 'Time weight',
  timeWeightDescription: '0 = purely semantic, 1 = purely by recency',
  userPriorityBoostLabel: 'Same-user boost',
  userPriorityBoostDescription:
    'In user mode, the hit score of messages from the same user is multiplied by this factor (>1 means they come first)',
  perItemMaxCharsLabel: 'Per-message truncation length',
  perItemMaxCharsDescription:
    'Character limit for each message shown to the LLM; 0 = no truncation (recommended). Anything beyond is marked with “…[已截断，还剩 N 个字符未展示]”.',
  minScoreLabel: 'Minimum similarity',
  minScoreDescription:
    '0~1; hits whose score (the semantic score before time weighting) is below this are dropped. 0 means no filtering',
  contextExpandLabel: 'Context expansion',
  contextExpandDescription:
    'After a hit, automatically fetch the N neighboring messages before and after it in its original session (including user/assistant/notice/tool) to restore the context. 0 = off.',
  windowLabel: 'Expansion window (N messages each side)',
  windowDescription: '0 = the hit only. 2~5 recommended',
  crossSessionLabel: 'Expand across sessions too',
  crossSessionDescription:
    'When a hit comes from another session (possible in user/all mode), whether to fetch context from that session as well',
  indexingLabel: 'Indexing settings',
  indexingDescription:
    'Controls peak shaving and concurrency of background vector indexing. The search path is not affected by this queue.',
  concurrencyLabel: 'Max concurrent indexing tasks',
  concurrencyDescription:
    'Number of background embedding + vector write tasks running at once. 0 or negative means no limit; 2~10 recommended, as too many may overwhelm a local embedding service.',
  maxQueueSizeLabel: 'Max indexing queue length',
  maxQueueSizeDescription:
    'Limit of the queue of messages waiting to be indexed. 0 or negative means no limit; beyond it the oldest waiting messages are dropped so memory does not grow without bound.',
  recallRolesLabel: 'Recall roles',
  recallRolesDescription:
    "Whether the AI's own past replies (role=assistant) take part in recall as semantic hits. The others-only option filters the **hits** (the candidate pool is doubled to compensate); neighbors pulled in by context expansion are not filtered and may still appear labeled “Assistant·你自己” (keeping the context intact). Whatever the option, assistant entries are always rendered with the role label (a guard against self-reinforcement that the switch does not turn off). Old vectors stored without a role are treated as user (the other party)",
  recallRolesAll: 'Recall both the other party and the AI itself',
  recallRolesOthers: "Recall only the other party (filter out the AI's own replies)",
  crossSessionModeLabel: 'Cross-session search mode',
  crossSessionModeDescription: 'Controls how far vector memory is visible across sessions',
  modeIsolated: 'Isolated (this session only)',
  modeUser: 'Same-user boost (across sessions, weighting the same user)',
  modePlatform: 'Same platform (sessions on the same platform only)',
  modeAll: 'Fully shared (all sessions on all platforms)',
  clearedAll: 'Cleared all vector memory',
  clearedSession: 'Cleared the vector memory of this session ({count, plural, one {# entry} other {# entries}})',
  clearUnsupported:
    'The current vector store cannot clear a single session, so vector memory was not cleared (use /clear.all instead, or switch to a backend that can delete by condition)',
  clearFailed: 'Clearing vector memory failed: {error}',
});

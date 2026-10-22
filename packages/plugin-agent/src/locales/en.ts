import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  systemNotice: '[System] {why}',
  turnError: '[Error] {error}',
  llmNoneErrored:
    'No LLM with the chat capability was found — these LLM plugins failed to activate: {plugins, list}. Use /doctor to see why (requires the corresponding permission).',
  llmNone:
    'No LLM with the chat capability was found — make sure at least one LLM provider plugin (such as @aalis/plugin-llm-deepseek) is installed and enabled.',
  llmNotFound: 'The model the configuration points to does not exist: {wanted}. Available now: {models, list}{more}.',
  llmMore: ' ({count, number} in total; use /model to see all)',
  llmUnresolved:
    'LLM resolution failed: {count, plural, one {# entry is} other {# entries are}} available after capability filtering, but none was obtained during resolution (the service may be loading or unloading; try again later).',
  partHistory: 'History',
  partToolResults: 'Tool results',
  partToolDefs: 'Tool definitions',
  partPersona: 'Persona',
  partMemorySummary: 'Conversation summary',
  partMemoryVector: 'Vector memory',
  partSkills: 'Skills',
  partPlatform: 'Platform prompt',
  partSubtask: 'Subtasks',
  partSystemOther: 'Other system prompts',
  llmLabel: 'Model',
  llmDescription:
    'The chat model this session uses. When unset it follows the service preference: the llm service preference set for this plugin if any, otherwise the global preference, and failing both the first available chat model',
  llmUnset: 'Follow the service preference',
  thinkLabel: 'Thinking',
  thinkDescription:
    'The available levels depend on the model in use; when unset, or when the current model lacks the level, the model’s default level is used',
  thinkUnset: 'The model’s default level',
  maxToolIterationsLabel: 'Max tool iterations',
  maxToolIterationsDescription: 'The maximum number of tool-call rounds in one turn',
  historyLimitLabel: 'History limit',
  historyLimitDescription:
    'At most this many messages of the conversation history are sent to the model: when exceeded, the oldest half is dropped at once, and history then builds up to this count again before the next chunk is dropped. The drop only affects what is sent to the model; the conversation history itself is kept and still goes into the summary when compacting. With the summary plugin installed, the conversation is compacted when its messages reach this count. 0 means no count limit: all active history is sent, and compaction follows only the automatic compaction threshold',
});

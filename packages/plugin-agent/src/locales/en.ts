import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Default agent',
  systemPromptLabel: 'Behavior guidelines prompt',
  systemPromptDescription:
    "Defines the agent's behavior guidelines. When a persona plugin is present, the persona provides the identity description and this is only appended as behavioral instructions.",
  memoryTokenBudgetLabel: 'Tokens reserved for long-term memory',
  memoryTokenBudgetDescription:
    'Token allowance for injected system messages (skills, summaries, memory, etc.) together. It only takes effect when trimming the history still leaves the prompt over budget: beyond the allowance they are shortened proportionally, and deleted if still over',
  promptBuildTimeoutMsLabel: 'Prompt contribution build timeout (ms)',
  promptBuildTimeoutMsDescription:
    'How long to wait for each block while assembling the prompt; a block that times out is left out of this turn while the rest proceed. 0 means no limit.',
  toolResultMaxRatioLabel: 'Maximum tool result ratio',
  toolResultMaxRatioDescription:
    'The largest share of the context window a single tool result may take (0~1); anything beyond is truncated. For example, 0.15 means 15%',
  trimThresholdRatioLabel: 'Trim threshold ratio',
  trimThresholdRatioDescription:
    'Share of the context window used as the trim budget, minus the max output and a safety margin. The default 1.0 uses the whole window; lower it to trim earlier. When to compact is set in the session settings “Auto-compaction threshold” and “History limit”.',
  systemNotice: '[System] {why}',
  turnError: '[Error] {error}',
  llmNoneErrored:
    'No model with the chat capability was found — these model plugins failed to activate: {plugins, list}. Use /doctor to see why (requires the corresponding permission).',
  llmNone:
    'No model with the chat capability was found — make sure at least one model provider plugin (such as @aalis/plugin-llm-deepseek) is installed and enabled.',
  llmNotFound: 'The model the configuration points to does not exist: {wanted}. Available now: {models, list}{more}.',
  llmMore: ' ({count, number} in total; use /model to see all)',
  llmUnresolved:
    'Model resolution failed: {count, plural, one {# entry is} other {# entries are}} available after capability filtering, but none was obtained during resolution (the service may be loading or unloading; try again later).',
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
    'The chat model this session uses. When unset it follows the service preference: the preference set for this plugin first, then the global preference, and failing both the first available chat model',
  llmUnset: 'Follow the service preference',
  thinkLabel: 'Thinking',
  thinkDescription:
    'The available levels depend on the model in use; when unset, or when the current model lacks the level, the model’s default level is used',
  thinkUnset: 'The model’s default level',
  maxToolIterationsLabel: 'Max tool iterations',
  maxToolIterationsDescription:
    'The maximum number of tool-call rounds in one turn. Unset means no limit, and a turn stuck in tool calls can only be stopped by hand',
  maxToolIterationsUnset: 'No limit',
  historyLimitLabel: 'History limit',
  historyLimitDescription:
    'At most this many messages of the conversation history are sent to the model; beyond it the oldest half is dropped (the conversation history itself is kept). With the summary plugin installed, the session is compacted at this count. 0 means no count limit, compacting only by the auto-compaction threshold',
  stopDescription:
    'Stop the turn running in this session; queued messages start the next turn as usual. Anyone taking part in this turn, and the owner, can stop it',
  stopped: 'Stopped this turn',
  stopIdle: 'No turn is running',
  stopDenied: 'Only those taking part in this turn and the owner can stop it',
  modelDescription: 'List or search available chat models. Paged, -p turns the page; e.g. /model grok',
  personaDescription: 'List or search available personas. Paged, -p turns the page',
  pageOptionDescription: 'Page number (default 1)',
  modelsLabel: 'available models',
  personasLabel: 'available personas',
  pagedNoMatch: 'No {label} match “{keyword}”',
  pagedNone: '(No {label})',
  pagedHeader: 'Showing {label} ({count, number} in total · page {page, number}/{pages, number}):',
  pagedHeaderMatching:
    'Showing {label} containing “{keyword}” ({count, number} in total · page {page, number}/{pages, number}):',
  pagedHint: '—— Next page: {command} -p {next}  Search: {command} <keyword>',
  pagedHintMatching: '—— Next page: {command} {keyword} -p {next}',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Default agent',
  systemPromptLabel: 'Behavior guidelines prompt',
  systemPromptDescription:
    "Defines the agent's behavior guidelines. When a persona plugin is present, the persona provides the identity description and this is only appended as behavioral instructions.",
  memoryTokenBudgetLabel: 'Tokens reserved for long-term memory',
  memoryTokenBudgetDescription:
    'Token allowance for injected system messages (skills, summaries, memory, etc.). It only takes effect when hard trimming has dropped all history and the prompt is still over budget: if together they exceed the allowance they are scaled down proportionally, and removed if still over',
  promptBuildTimeoutMsLabel: 'Prompt contribution build timeout (ms)',
  promptBuildTimeoutMsDescription:
    'How long to wait for a single agent:prompt contribution build. A hung build (such as a stuck network lookup) is left out of this turn after the timeout while the rest proceed, so it does not hold up every LLM call. 0 means no limit.',
  toolResultMaxRatioLabel: 'Maximum tool result ratio',
  toolResultMaxRatioDescription:
    'The largest share of the context window a single tool result may take (0~1); anything beyond is truncated. For example, 0.15 means 15%',
  trimThresholdRatioLabel: 'Trim threshold ratio',
  trimThresholdRatioDescription:
    'Trim budget = context length × this ratio − max output tokens − 512 safety margin (at least 1024). Hard trimming trims the message list about to be sent to fit it (only in memory, the DB is untouched): history beyond what is available (the budget minus the head and a quarter of the budget) is dropped in segments, and the other steps only run when the estimate exceeds the budget. The default 1.0 uses the whole window left after reserving output; lower it to trim earlier. Compaction triggers are set in session settings: the auto-compaction threshold (summary plugin) and the history limit (this plugin).',
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
  maxToolIterationsDescription:
    'The maximum number of tool-call rounds in one turn. Unset means no limit, and a turn stuck in tool calls can only be stopped by hand',
  maxToolIterationsUnset: 'No limit',
  historyLimitLabel: 'History limit',
  historyLimitDescription:
    'At most this many messages of the conversation history are sent to the model: when exceeded, the oldest half is dropped at once, and history then builds up to this count again before the next chunk is dropped. The drop only affects what is sent to the model; the conversation history itself is kept and still goes into the summary when compacting. With the summary plugin installed, the conversation is compacted when its messages reach this count. 0 means no count limit: all active history is sent, and compaction follows only the automatic compaction threshold',
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

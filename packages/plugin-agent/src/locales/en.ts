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
  noSessionManager:
    'Session management is not running, and session settings depend on it: enable “Session management” in the WebUI plugin area, or remove it from disabledPlugins in the config file; if it still does not start, use /doctor to see why',
  sessionLine: 'Session: {session}',
  fieldModel: 'Model',
  fieldPersona: 'Persona',
  fieldThink: 'Thinking',
  inheritedLine: '{field}: {value}  [source: {from}]',
  overrideLine: '{field}: {value}  [source: session override]',
  overriddenLine: '  Overridden inherited value: {value}  [source: {from}]',
  unsetValue: '(default)',
  fromDefault: 'default',
  fromPlatform: '{layer} {platform}',
  fromType: '{layer} {platform} · {type}',
  fromPlace: '{layer} “{place}”',
  modelInUse: '  This turn will use: {model}',
  thinkingFixed: '  Not adjustable on the current model',
  thinkingLevels: '  Levels of the current model: {levels, list}; default {fallback}',
  thinkingLevelsMissing:
    '  Levels of the current model: {levels, list}; default {fallback}; the current model does not have this level, so the default is used',
  thinkingLevel: '{id} ({label})',
  noSuchLevel: 'The current model has no level “{level}”; options: {levels, list, or}',
  noOwnRecord: '(This conversation has no settings of its own yet; everything is inherited from the defaults)',
  setHint:
    'Change settings: /session.set -m <model> -p <persona> -t <level> [-n <name>]   (/model lists the available models; a wrong persona name lists the available personas)',
  resetHint: 'Reset:   /session.reset          (-m model only / -p persona only / -t thinking only)',
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
  historyLimitDescription:
    'At most this many messages of the conversation history are sent to the model: when exceeded, the oldest half is dropped at once, and history then builds up to this count again before the next chunk is dropped. The drop only affects what is sent to the model; the conversation history itself is kept and still goes into the summary when compacting. With the summary plugin installed, the conversation is compacted when its messages reach this count. 0 means no count limit: all active history is sent, and compaction follows only the automatic compaction threshold',
});

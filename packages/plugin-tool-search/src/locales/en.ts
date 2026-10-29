import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Tool search',
  enabledLabel: 'Enable the tool search layer',
  enabledDescription: 'When off, all tools are sent to the LLM directly, without the search layer',
  showToolNamesLabel: 'Show the capability catalog',
  showToolNamesDescription:
    "When on, the description of search_tools summarizes this turn's available groups, what they can do and example tool names; the model has to call search_tools for the exact usage before it can use a tool. When off, the model sees only search_tools and has to search before it can discover tools.",
  maxDirectToolsLabel: 'Direct pass threshold',
  maxDirectToolsDescription:
    'When the total number of registered tools does not exceed this value, the search layer is skipped and all tools are sent to the LLM directly',
  maxSearchResultsLabel: 'Max search results',
  maxSearchResultsDescription: 'Maximum number of tools returned per search; 0 means no limit',
  alwaysDirectToolsLabel: 'Always-direct tools',
  alwaysDirectToolsDescription:
    'Even with the tool search layer on, the full definitions of these tools are always exposed directly. Enter tool names, such as web_search.',
  maxDiscoveredKeepLabel: 'Discovered tool queue limit',
  maxDiscoveredKeepDescription:
    'Keep at most N "discovered tools" inferred from the message history (keeping the most recently used, 0 = no limit), so that the discovered set does not grow without bound in long sessions and the search layer keeps its slimming value.',
});

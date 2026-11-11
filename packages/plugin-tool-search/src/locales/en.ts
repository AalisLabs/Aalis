import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Tool search',
  enabledLabel: 'Enable the tool search layer',
  enabledDescription: 'When off, all tools are sent to the model directly, without the search layer',
  showToolNamesLabel: 'Show the capability catalog',
  showToolNamesDescription:
    "When on, the search_tools description lists this turn's available capabilities, though tools still have to be searched before use; when off, the model has to search before it can discover tools.",
  maxDirectToolsLabel: 'Direct pass threshold',
  maxDirectToolsDescription:
    'When the total number of registered tools does not exceed this value, the search layer is skipped and all tools are sent to the model directly',
  maxSearchResultsLabel: 'Max search results',
  maxSearchResultsDescription: 'Maximum number of tools returned per search; 0 means no limit',
  alwaysDirectToolsLabel: 'Always-direct tools',
  alwaysDirectToolsDescription:
    'Even with the tool search layer on, the full definitions of these tools are always exposed directly. Enter tool names, such as web_search.',
  maxDiscoveredKeepLabel: 'Discovered tool queue limit',
  maxDiscoveredKeepDescription:
    'How many discovered tools inferred from the message history are kept, most recently used first; 0 = no limit.',
});

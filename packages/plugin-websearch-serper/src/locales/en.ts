import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Serper web search',
  apiKeyDescription: 'Serper.dev API key',
  maxPerMinuteLabel: 'Max per minute',
  maxPerMinuteDescription: 'Rate limit: maximum searches per minute',
  maxPerDayLabel: 'Max per day',
  maxPerDayDescription: 'Rate limit: maximum searches per day',
  maxConcurrentLabel: 'Max concurrent',
  maxConcurrentDescription: 'Maximum number of search requests at once',
  defaultNumResultsLabel: 'Default number of results',
  defaultNumResultsDescription: 'Number of results returned per search',
  enableCompressionLabel: 'Enable search result compression',
  enableCompressionDescription:
    'When on, search results are first compressed and merged by a model before being returned to the agent, using fewer tokens and improving the quality of the information.',
  compressionPromptLabel: 'Compression prompt',
  compressionPromptDescription:
    "Custom prompt for compressing search results. Left empty, the default prompt is used. In the prompt, '{query}' stands for the search keywords and '{results}' for the search results (without '{results}', the model gets no results).",
  groupLabel: 'Web search',
  groupSummary: 'Search the internet for up-to-date information through the Serper API',
});

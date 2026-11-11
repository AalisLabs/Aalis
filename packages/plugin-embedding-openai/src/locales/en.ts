import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  apiKeyDescription: 'OpenAI API key',
  baseUrlLabel: 'API URL',
  baseUrlDescription:
    'Full prefix of the API endpoint (including the version segment); the plugin only appends /embeddings and /models to it',
  modelLabel: 'Embedding model',
  modelDescription: 'The model used to turn text into vectors',
  timeoutMsLabel: 'Request timeout (ms)',
  timeoutMsDescription: 'Timeout of a single embedding request.',
  baseUrlInvalid: 'baseUrl must be a full URL without a user name or password',
  baseUrlQuery:
    'baseUrl cannot contain a query string or fragment (anything after ? or #): the plugin appends paths to it',
});

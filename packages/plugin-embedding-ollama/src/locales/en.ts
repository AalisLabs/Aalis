import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  baseUrlLabel: 'Ollama URL',
  baseUrlDescription: 'HTTP address of the local Ollama service',
  modelLabel: 'Embedding model',
  modelDescription: 'The model used to turn text into vectors',
  timeoutMsLabel: 'Request timeout (ms)',
  timeoutMsDescription: 'Timeout of a single embedding request',
  retriesLabel: 'Retries on failure',
  retriesDescription: 'How many times to retry when fetch fails or returns 5xx',
  baseUrlInvalid: 'baseUrl must be a full URL without a user name or password',
  baseUrlQuery:
    'baseUrl cannot contain a query string or fragment (anything after ? or #): the plugin appends paths to it',
  statusFailed: 'Ollama embedding request failed ({endpoint}): {status} {statusText}',
  statusFailedDetail: 'Ollama embedding request failed ({endpoint}): {status} {statusText} — {detail}',
  probeTimeout: 'Probe timed out ({ms}ms)',
  checkOk: 'Ollama Embedding available ({model} @ {baseUrl})',
  checkFailed: 'Ollama Embedding unavailable ({model} @ {baseUrl}) — vector memory is not working',
  checkFix:
    'Make sure Ollama is running and you have run ollama pull {model} (or change the model config item to an embedding model this machine has)',
});

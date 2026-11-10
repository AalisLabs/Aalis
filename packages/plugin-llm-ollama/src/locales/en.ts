import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  baseUrlInvalid: 'baseUrl is not a valid URL; write it as a full address, such as http://localhost:11434',
  baseUrlQuery:
    'baseUrl cannot contain a query string or fragment (anything after ? or #): the plugin appends paths to it',
  baseUrlCredentials:
    'baseUrl cannot contain a user name or password (user:pass@); this plugin does not support accessing Ollama with credentials',
  withCause: '{error} ← {detail}',
  hintAuth: 'invalid key or no permission',
  hintPayment: 'insufficient balance or payment required',
  hintNotFound: 'wrong model or address',
  hintRateLimit: 'too many requests or quota exhausted',
  hintUpstream: 'upstream service failure',
  apiError: '{provider} API error ({status})',
  apiErrorHint: '{provider} API error ({status}): {hint}',
  upstreamMessage: 'upstream message: {message}',
  seeLogs: 'see the logs for details',
  levelOff: 'Off',
  levelOn: 'On',
  baseUrlLabel: 'Ollama URL',
  baseUrlDescription: 'HTTP address of the local Ollama service',
  customModelsLabel: 'Custom models',
  customModelsDescription:
    'Model names added by hand (one per line or comma-separated), for models missing from the discovered list. Names that duplicate discovered models are flagged so you can remove them.',
  discoverModelsLabel: 'Discover models',
  discoverModelsDescription:
    'Request /api/tags at startup to discover the installed models; the WebUI can refresh the model list. Turn it off when the service does not provide /api/tags: no discovery request is sent, only customModels are registered (then required), and refreshing is not supported.',
  modelCapabilitiesLabel: 'Per-model capability overrides',
  modelCapabilitiesDescription:
    "Force a model's capabilities (highest priority, above /api/show detection and the built-in family table), combined with the adapter defaults.\nFormat: `<modelId>: <cap1>,<cap2>,...`, one per line. For example: nemotron3:33b: chat,vision,tool_calling",
  providerCapabilitiesLabel: 'Adapter default capabilities (comma-separated)',
  providerCapabilitiesDescription:
    'Fallback default capabilities: only used when a model can neither be probed through Ollama /api/show nor found in the built-in family table. Capabilities are now detected automatically, so this is usually left empty (filling it in may mislabel models that lack those capabilities). For example: chat,tool_calling,streaming',
  timeoutLabel: 'Idle timeout (s)',
  timeoutDescription:
    'How long without new output counts as a timeout (seconds). Output that keeps coming (thinking included) never times out; tool calls only arrive once Ollama has generated them in full, and the time spent generating them does not count as output; a non-streaming request (including requests with audio) must receive the whole reply within this time. Raise it for large models or long contexts that are slow to produce their first output, or for long tool arguments. 0 = no limit.',
  temperatureLabel: 'Temperature',
  temperatureDescription: '0-2; higher is more random',
  maxTokensLabel: 'Max tokens',
  maxTokensDescription:
    'Maximum tokens generated per reply (num_predict); must be a positive integer, otherwise the instance goes into error',
  contextLengthLabel: 'Context length',
  contextLengthDescription: "Size of the model's context window (num_ctx)",
  keepAliveLabel: 'Model keep-alive',
  keepAliveDescription: 'How long the model stays in GPU memory, such as 5m, 1h, or 0 (unload immediately)',
  thinkingLabel: 'Default thinking level',
  thinkingDescription:
    'The level used by models that report the thinking capability (or have thinking in the per-model capability overrides) when a request names no level; the session setting “Thinking” takes precedence. Models without the thinking capability are not sent the think parameter.',
  requestTimeout: 'Ollama request timed out: no new output within {seconds} s; you can raise timeout in the config',
  pluginClosed: 'The Ollama plugin was disabled or reloaded; this request was not sent',
  pluginStopped: 'The Ollama plugin was disabled or reloaded; this request was stopped midway',
  unreachable: 'Ollama cannot reach the service: check baseUrl and the network; see the logs for details',
  notJson: 'The Ollama response is not JSON ({status}); see the logs for details',
  discoveryNotJson: 'the response is not JSON: {excerpt}',
  discoveryNotList:
    'the response is not a model list (it needs a models array whose items each have a string name): {excerpt}',
  discoveryFailed: 'Model discovery failed for {url}: {error}',
  emptyBody: 'The Ollama API returned an empty response body, so the stream cannot be read',
  imagesUnavailable: 'Could not get any of the images ({count} in total); refusing to fall back to a text-only request',
  audioDataUrlOnly:
    "Ollama's compatible API only accepts audio as data:audio/<format>;base64, (the plugin does not read local paths or links)",
  audioFormatUnsupported: "Ollama's compatible API does not accept {format} audio",
  customModelsRequired: 'required when discoverModels is off',
  noModelsDiscoveryFailed:
    'Could not get the Ollama model list, so there are no models to register: make sure Ollama is running and baseUrl is right, then reload this plugin, or list the models to use in customModels. Reason: {error}',
  noModels:
    'Ollama is connected at {baseUrl} but found no available models; download one with ollama pull first, or list the models to use in customModels',
  noChatModels:
    'Ollama is connected at {baseUrl} but has no usable chat model: none of {models} reports the chat capability (embedding models, for example); download a chat model with ollama pull first',
});

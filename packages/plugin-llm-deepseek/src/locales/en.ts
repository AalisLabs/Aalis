import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  baseUrlInvalid: 'baseUrl is not a valid URL; write it as a full address, such as https://api.deepseek.com',
  baseUrlQuery:
    'baseUrl cannot contain a query string or fragment (anything after ? or #): the plugin appends paths to it',
  baseUrlCredentials: 'baseUrl cannot contain a user name or password (user:pass@); put the key in apiKey',
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
  levelHigh: 'High',
  levelAuto: 'Auto',
  levelMax: 'Max',
  apiKeyDescription: 'DeepSeek API key',
  baseUrlLabel: 'API URL',
  baseUrlDescription:
    'Full prefix of the API endpoint (the official one has no version segment); the plugin only appends /chat/completions and /models to it',
  customModelsLabel: 'Custom models',
  customModelsDescription:
    'Model names added by hand (one per line or comma-separated), for models missing from the discovered list. Names that duplicate discovered models are flagged so you can remove them.',
  discoverModelsLabel: 'Discover models',
  discoverModelsDescription:
    'Query the service for available models at startup. Turn it off when the service has no model list; only custom models are then used, and they are required.',
  modelCapabilitiesLabel: 'Per-model capability overrides',
  modelCapabilitiesDescription:
    'Capabilities per model. A listed model is no longer inferred from its name; it gets the capabilities written here plus the adapter default capabilities.\nFormat: `<modelId>: <cap1>,<cap2>,...`, one per line. For example: deepseek-flash: chat,tool_calling,streaming,thinking,vision\nAvailable capabilities: chat / tool_calling / vision / streaming / thinking and so on.',
  providerCapabilitiesLabel: 'Adapter default capabilities',
  providerCapabilitiesDescription:
    'Capabilities added to every model, comma-separated. For example: chat,tool_calling,streaming',
  timeoutLabel: 'Idle timeout (s)',
  timeoutDescription:
    'How long without new output counts as a timeout; steady output (thinking included) never times out, and a non-streaming request must receive the whole reply within this time. 0 = no limit.',
  temperatureLabel: 'Temperature',
  temperatureDescription: '0-2; higher is more random',
  maxTokensLabel: 'Max tokens',
  maxTokensDescription:
    'Maximum tokens generated per reply; must be a positive integer, otherwise the instance goes into error',
  contextLengthLabel: 'Context length',
  contextLengthDescription: "Size of the model's context window",
  strictToolCallsLabel: 'Strict tool calls',
  strictToolCallsDescription:
    'When on, every tool definition uses strict mode, so the arguments the model gives strictly follow the JSON Schema.',
  forceJsonOutputLabel: 'Force JSON output',
  forceJsonOutputDescription:
    "When on, requests without tools ask the model for JSON output, for use with a persona card's output format. The system prompt must contain the word json.",
  thinkingLabel: 'Default thinking level',
  thinkingDescription:
    'The level models that can think use when a request names no level; the session setting “Thinking” takes precedence. Auto: thinking on, with DeepSeek choosing between High and Max.',
  requestTimeout: 'DeepSeek request timed out: no new output within {seconds} s; you can raise timeout in the config',
  pluginClosed: 'The DeepSeek plugin was disabled or reloaded; this request was not sent',
  pluginStopped: 'The DeepSeek plugin was disabled or reloaded; this request was stopped midway',
  unreachable: 'DeepSeek cannot reach the service: check baseUrl and the network; see the logs for details',
  notJson: 'The DeepSeek response is not JSON ({status}); see the logs for details',
  discoveryNotJson: 'the response is not JSON: {excerpt}',
  discoveryNotList:
    'the response is not a model list (it needs a data array whose items each have a string id): {excerpt}',
  discoveryFailed: 'Model discovery failed for {url}: {error}',
  emptyChoices: 'DeepSeek returned empty choices',
  emptyBody: 'The DeepSeek API returned an empty response body, so the stream cannot be read',
  customModelsRequired: 'required when discoverModels is off',
  noModelsDiscoveryFailed:
    'Could not get the model list, so there are no models to register: check apiKey, baseUrl and the network, then reload this plugin, or list the models to use in customModels. Reason: {error}',
  noModels: 'Connected to {baseUrl} but found no available models; you can list the models to use in customModels',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  baseUrlInvalid: 'baseUrl is not a valid URL; write it as a full address, such as https://api.openai.com/v1',
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
  levelOn: 'On',
  levelMinimal: 'Minimal',
  levelLow: 'Low',
  levelMedium: 'Medium',
  levelHigh: 'High',
  apiKeyDescription: 'OpenAI API key (may be left empty for local services)',
  baseUrlLabel: 'API URL',
  baseUrlDescription:
    "Write it up to the version segment, such as https://api.openai.com/v1; the plugin appends /chat/completions and /models. Any compatible service's address works too.",
  customModelsLabel: 'Custom models',
  customModelsDescription:
    'Model names added by hand (one per line or comma-separated), for models missing from the discovered list. Names that duplicate discovered models are flagged so you can remove them.',
  discoverModelsLabel: 'Discover models',
  discoverModelsDescription:
    'Query the service for available models at startup; the WebUI can refresh them later. Turn it off when the service has no model list; only custom models (then required) are used and refreshing is not available.',
  modelCapabilitiesLabel: 'Per-model capability overrides',
  modelCapabilitiesDescription:
    'Capabilities per model. A listed model is no longer inferred from its name; it gets the capabilities written here plus the adapter default capabilities.\nFormat: `<modelId>: <cap1>,<cap2>,...`, one per line. For example: gpt-4o: chat,tool_calling,vision,streaming\nAvailable capabilities: chat / tool_calling / vision / streaming / thinking and so on.',
  providerCapabilitiesLabel: 'Adapter default capabilities',
  providerCapabilitiesDescription:
    'Capabilities added to every model, comma-separated. For example: chat,tool_calling,streaming',
  timeoutLabel: 'Idle timeout (s)',
  timeoutDescription:
    'How long without new output counts as a timeout; steady output never times out, and a non-streaming request must receive the whole reply within this time. Raise it when the model does not stream its thinking or the input is long. 0 = no limit.',
  temperatureLabel: 'Temperature',
  temperatureDescription: '0-2; higher is more random',
  maxTokensLabel: 'Max tokens',
  maxTokensDescription:
    'Maximum tokens generated per reply; must be a positive integer, otherwise the instance goes into error',
  contextLengthLabel: 'Context length',
  contextLengthDescription: "Size of the model's context window",
  thinkingParamLabel: 'Thinking level format',
  thinkingParamEffort: 'reasoning_effort: levels by model family (official OpenAI and most compatible endpoints)',
  thinkingParamThinking: 'thinking.type: off and on (DeepSeek-style endpoints or relays)',
  thinkingParamDescription:
    'How models that can think send their thinking level; nothing is sent when a request names no level. If the endpoint rejects requests because it does not recognize the field, switch to the other format, or remove thinking for that model in the per-model capability overrides.',
  requestTimeout: 'LLM request timed out: no new output within {seconds} s; you can raise timeout in the config',
  pluginClosed: 'The LLM plugin was disabled or reloaded; this request was not sent',
  pluginStopped: 'The LLM plugin was disabled or reloaded; this request was stopped midway',
  unreachable: 'LLM cannot reach the service: check baseUrl and the network; see the logs for details',
  notJson: 'The LLM response is not JSON ({status}); see the logs for details',
  discoveryNotJson: 'the response is not JSON: {excerpt}',
  discoveryNotList:
    'the response is not a model list (it needs a data array whose items each have a string id): {excerpt}',
  discoveryFailed: 'Model discovery failed for {url}: {error}',
  emptyChoices: 'LLM returned empty choices',
  emptyBody: 'The LLM API returned an empty response body, so the stream cannot be read',
  apiKeyRequired: 'required when using the official OpenAI API',
  customModelsRequired: 'required when discoverModels is off',
  noModelsDiscoveryFailed:
    'Could not get the model list, so there are no models to register: check apiKey, baseUrl and the network, then reload this plugin, or list the models to use in customModels. Reason: {error}',
  noModels: 'Connected to {baseUrl} but found no available models; you can list the models to use in customModels',
});

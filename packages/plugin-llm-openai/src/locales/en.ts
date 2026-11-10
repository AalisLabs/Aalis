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
    'Full prefix of the API endpoint (including the version segment, such as https://api.openai.com/v1); the plugin only appends /chat/completions and /models to it. Any compatible service can be used instead (such as Gemini at https://generativelanguage.googleapis.com/v1beta/openai).',
  customModelsLabel: 'Custom models',
  customModelsDescription:
    'Model names added by hand (one per line or comma-separated), for models missing from the discovered list. Names that duplicate discovered models are flagged so you can remove them.',
  discoverModelsLabel: 'Discover models',
  discoverModelsDescription:
    'Request /models at startup to discover the available models; the WebUI can refresh the model list. Turn it off when the gateway does not provide /models: no discovery request is sent, only customModels are registered (then required), and refreshing is not supported.',
  modelCapabilitiesLabel: 'Per-model capability overrides',
  modelCapabilitiesDescription:
    "Set a model's capabilities line by line. A line for a model **overrides** the plugin's heuristics and is still combined with the adapter defaults.\nFormat: `<modelId>: <cap1>,<cap2>,...`, one per line. For example: gpt-4o: chat,tool_calling,vision,streaming\nAvailable capabilities: chat / tool_calling / vision / streaming / thinking and so on.",
  providerCapabilitiesLabel: 'Adapter default capabilities (comma-separated)',
  providerCapabilitiesDescription:
    "Capabilities added to every model of this adapter. A model's capabilities = these ∪ its per-model capabilities. For example: chat,tool_calling,streaming",
  timeoutLabel: 'Idle timeout (s)',
  timeoutDescription:
    'How long without new output counts as a timeout (seconds). Output that keeps coming never times out; a non-streaming request must receive the whole reply within this time. Raise it when the model thinks without streaming its thinking (such as the official OpenAI reasoning models) or the input is long. 0 = no limit.',
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
    'Models that can think (the o series and gpt-5 series in the built-in table, except gpt-5-chat, or those with thinking in the per-model capability overrides) offer thinking levels in this format. The field is only sent when a request names a level; otherwise nothing is sent and the endpoint uses its own default. An endpoint that does not recognize the chosen field rejects requests that name a level; then switch to the other format, or remove thinking for that model in the per-model capability overrides.',
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

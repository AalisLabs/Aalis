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
    'Request /models at startup to discover the available models. Turn it off when the gateway does not provide /models: no discovery request is sent and only customModels are registered (then required).',
  modelCapabilitiesLabel: 'Per-model capability overrides',
  modelCapabilitiesDescription:
    "Set a model's capabilities line by line. A line for a model **overrides** the plugin's heuristics and is still combined with the adapter defaults.\nFormat: `<modelId>: <cap1>,<cap2>,...`, one per line. For example: deepseek-flash: chat,tool_calling,streaming,thinking,vision\nAvailable capabilities: chat / tool_calling / vision / streaming / thinking and so on.",
  providerCapabilitiesLabel: 'Adapter default capabilities (comma-separated)',
  providerCapabilitiesDescription:
    "Capabilities added to every model of this adapter. A model's capabilities = these ∪ its per-model capabilities. For example: chat,tool_calling,streaming",
  timeoutLabel: 'Idle timeout (s)',
  timeoutDescription:
    'How long without new output counts as a timeout (seconds). Output that keeps coming (thinking included) never times out; a non-streaming request must receive the whole reply within this time. 0 = no limit.',
  temperatureLabel: 'Temperature',
  temperatureDescription: '0-2; higher is more random',
  maxTokensLabel: 'Max tokens',
  maxTokensDescription:
    'Maximum tokens generated per reply; must be a positive integer, otherwise the instance goes into error',
  contextLengthLabel: 'Context length',
  contextLengthDescription: "Size of the model's context window",
  strictToolCallsLabel: 'Strict tool calls',
  strictToolCallsDescription:
    'When on, every tool call uses strict mode and the model output strictly follows the JSON Schema (see api-docs.deepseek.com)',
  forceJsonOutputLabel: 'Force JSON output',
  forceJsonOutputDescription:
    "When on, every final-reply request carries response_format: '{type:\"json_object\"}'; together with a persona card's outputFormat this improves format compliance. The tool-call phase is not affected (tool responses go through the tool_calls field). The system prompt must contain the word json (persona cards with outputFormat enabled meet this automatically).",
  thinkingLabel: 'Default thinking level',
  thinkingDescription:
    'The level used by models that can think (v4, reasoner and so on, or those with thinking in the per-model capability overrides) when a request names no level; the session setting “Thinking” takes precedence. Auto: thinking on, with DeepSeek choosing between High and Max by context. Models that cannot think are always sent with Off.',
  requestTimeout: 'DeepSeek request timed out: no new output within {seconds} s; you can raise timeout in the config',
  pluginClosed: 'The DeepSeek plugin was disabled or reloaded; this request was not sent',
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

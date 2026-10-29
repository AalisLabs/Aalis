import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Cursor cloud agents',
  apiKeyDescription:
    'API key generated in the Cursor dashboard. Only used in the host process, never passed to the remote agent',
  apiKeyNote: 'generate it in the Cursor dashboard',
  baseUrlLabel: 'API address',
  baseUrlDescription: 'Root address of the Cloud Agents API; the plugin appends /v1/… to it',
  modelLabel: 'Model',
  modelDescription:
    'The model agents are created with. Parameters must be written in full and equal one of the variants listed by /v1/models; this is checked on first use, and the provider is unavailable if it does not hold. Writing only the model id is billed at the default variant (fast, 500k)',
  modelIdLabel: 'Model id',
  modelParamsLabel: 'Model parameters',
  modelParamsDescription:
    'Parameter names to values; booleans must be quoted as strings (such as fast: "false"); a mistake keeps the plugin from activating, so the billing tier does not change',
  egressModeLabel: 'Egress mode',
  egressNone: 'No egress',
  egressAllowlist: 'Allowlist',
  egressOpen: 'Unrestricted',
  egressUnknown: 'Unknown',
  egressModeDescription:
    'The egress mode the owner set for cloud agents in the Cursor dashboard. The API cannot read it and Aalis cannot verify it, so the Paper page and the diagnostic mark it as unverified; unknown counts as unrestricted',
  createTimeoutSecondsLabel: 'Create agent timeout (seconds)',
  createTimeoutSecondsDescription:
    'The request that creates an agent takes about 60 seconds to answer; after a timeout it is fetched again with the same agentId, not created twice',
  requestTimeoutSecondsLabel: 'Request timeout (seconds)',
  requestTimeoutSecondsDescription:
    'Timeout of the other requests; a single request was measured to take more than 5 seconds at times',
  streamIdleSecondsLabel: 'Event stream idle timeout (seconds)',
  streamIdleSecondsDescription:
    'After the event stream connects, the first heartbeat comes after about 30 seconds and then every 15 to 30 seconds; with no data at all for this long, it disconnects and reconnects',
  reconcileIgnoreNamesLabel: 'Agent names managed by the owner',
  reconcileIgnoreNamesDescription:
    'These names are skipped when listing the agents of the account, and reconciliation does not treat them as agents outside the ledger',
  baseUrlNotPlain: 'baseUrl must be a complete URL without a user name or password',
  baseUrlHasQuery:
    'baseUrl must not contain a query string or fragment (anything after ? or #): the plugin appends paths to it',
});

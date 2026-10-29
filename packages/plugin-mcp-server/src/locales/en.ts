import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'MCP server',
  portLabel: 'Listening port',
  portDescription:
    'Must be 1-65535; an invalid value is reported as an error and the server does not start. To pause the service, disable this plugin in the plugin list.',
  bindLabel: 'Listening address',
  bindEmpty: 'bind must not be empty',
  tokenLabel: 'Access token',
  tokenDescription:
    'External MCP clients connecting to /sse and /messages must send the header Authorization: Bearer <token>. At least 32 visible ASCII characters with no whitespace; can be generated with openssl rand -hex 32. Stored in the secret store, and the WebUI does not show it back',
  tokenInvalid: 'must be at least 32 visible ASCII characters (no whitespace)',
  toolGroupsLabel: 'Allowed tool groups (empty = all, subject to the restricted switch)',
  toolGroupsDescription: "An empty list or ['*'] = expose tools of all groups (still subject to allowRestricted).",
  allowRestrictedLabel: 'Allow exposing restricted tools',
});

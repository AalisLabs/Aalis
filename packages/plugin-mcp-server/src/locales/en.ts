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
    'External MCP clients must send it in the header Authorization: Bearer <token>. At least 32 visible ASCII characters with no whitespace; can be generated with openssl rand -hex 32',
  tokenInvalid: 'must be at least 32 visible ASCII characters (no whitespace)',
  toolGroupsLabel: 'Allowed tool groups',
  toolGroupsDescription:
    "An empty list or ['*'] = expose tools of all groups (still subject to “Allow exposing restricted tools”).",
  allowRestrictedLabel: 'Allow exposing restricted tools',
});

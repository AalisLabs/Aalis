import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'MCP client',
  serversLabel: 'MCP servers',
  serversDescription:
    'MCP servers connected over stdio. Each entry needs at least id and command; adjust the security level as needed.',
  idLabel: 'Unique ID',
  idDescription:
    'Used as the tool namespace; the final tool names look like mcp_<id>_<tool>. Only letters, digits, underscores and hyphens are allowed.',
  commandLabel: 'Executable command',
  commandDescription: 'A command name (such as npx / node / python, looked up in PATH) or an absolute path.',
  argsLabel: 'Command arguments',
  argsDescription:
    'Arguments passed to the command in order, one per item (may contain spaces). Write file paths in arguments as absolute paths.',
  envLabel: 'Environment variables',
  envDescription:
    'Extra environment variables passed to the child process (KEY → VALUE). The whole map is stored in secrets.yaml as one secret; the WebUI does not show it back, and changing it means re-entering all of it. Put credentials such as tokens here, not in the command arguments (arguments are written to the logs).',
  enabledLabel: 'Enabled',
  enabledDescription: 'Turn off to skip this server for now without deleting the whole entry.',
  visibilityLabel: 'Tool level',
  visibilityDescription:
    'Level of all tools of this server. auto = by tool annotations: self-declared read-only → sensitive (level 1), destructive hints or nothing declared → restricted (level 2). public restores level 0, open to everyone (the old 0.x default).',
  visibilityAuto: 'auto (by annotations)',
  visibilityPublic: 'public (level 0, open to everyone)',
  visibilitySensitive: 'sensitive (level 1)',
  visibilityRestricted: 'restricted (level 2)',
  connectFailedTitle: 'Cannot connect to MCP server “{id}”',
  connectFailedDetail:
    "Check this server's command, args and env (the environment variables it needs); saving the configuration after fixing them reconnects it. Reason: {reason}",
  serverGroupSummary: 'Remote MCP server “{id}” bridged by plugin-mcp-client',
  metaGroup: 'MCP / metadata',
  metaGroupSummary:
    'Let the agent list configured MCP servers and turn them on or off (entries cannot be added or removed)',
});

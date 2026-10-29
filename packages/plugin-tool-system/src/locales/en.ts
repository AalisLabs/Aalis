import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'System tools',
  groupSummary: 'System-level tools: shell commands, file operations, system information and HTTP requests',
  workingDirectoryLabel: 'Initial working directory',
  workingDirectoryDescription:
    'The initial cwd when the process starts (Unix mental model). The agent can switch it within a session with the cd tool; that is not written back to this setting. shell starts from this initial value and is not affected by cd; code-runner uses its own workingDirectory setting.',
  shellLabel: 'Shell tools',
  shellEnabledLabel: 'Enable shell tools',
  maxOutputSizeLabel: 'Max output bytes',
  fileLabel: 'File tools',
  fileEnabledLabel: 'Enable file tools',
  maxReadSizeLabel: 'Max read bytes',
  maxSearchBytesLabel: 'Max bytes scanned per search',
  maxWriteSizeLabel: 'Max write bytes',
  allowedRootsLabel: 'Allowed storage roots',
  allowedRootsDescription:
    "By default only the agent workspace (workspace/tmp), not system roots such as data (so data:/users.json and the like cannot be read directly). Set * to open all readable roots, or list root names explicitly. Writes and deletes are still limited by each root's own permissions.",
  rootAllReadable: 'All readable roots',
  rootTmp: 'Temporary directory',
  rootPluginData: 'Plugin data',
  rootLogs: 'Logs',
  systemEnabledLabel: 'Enable system tools',
  httpLabel: 'HTTP tools',
  httpEnabledLabel: 'Enable HTTP tools',
  defaultTimeoutLabel: 'Default timeout (ms)',
  defaultTimeoutDescription:
    "Default timeout of http_request; http_download has no timeout of its own, how long it waits is governed by the tool executor's yield limit",
  maxResponseSizeLabel: 'Max response bytes',
  toolsDescription: 'List all registered machine interaction tools',
  toolsHeading: 'Machine interaction tools:',
});

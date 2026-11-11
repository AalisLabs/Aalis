import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'System tools',
  groupSummary: 'System-level tools: shell commands, file operations, system information and HTTP requests',
  workingDirectoryLabel: 'Initial working directory',
  workingDirectoryDescription:
    'Initial working directory of each session. The model can switch it within a session with cd, which is not written back to this setting; shell runs here by default and is not affected by cd.',
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
    "Storage roots the file tools may access; by default only workspace and tmp. Add other roots or choose “All readable roots”; writes and deletes are still limited by each root's own permissions.",
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

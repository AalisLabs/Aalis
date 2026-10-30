import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Code runner',
  groupLabel: 'Code execution',
  groupSummary:
    'Write and run Python / JavaScript code to solve computation, analysis, file processing and similar problems',
  enableTool: 'Enable {tool}',
  interpreterLabel: 'Interpreter path',
  pythonInterpreterDescription: 'Path or command name of the Python interpreter, such as python3 or /usr/bin/python3',
  javascriptInterpreterDescription: 'Path or command name of the Node.js interpreter',
  maxOutputSizeLabel: 'Max output bytes',
  maxOutputSizeDescription: 'Maximum output bytes for stdout and stderr each',
  workingDirectoryLabel: 'Logical working directory',
  workingDirectoryDescription:
    'Working directory (a storage URI) for running scripts, such as workspace:/ or tmp:/run; relative paths are resolved under workspace:/.',
  sandboxLabel: 'Code sandbox',
  modeLabel: 'Isolation mode',
  modeAuto: 'Automatic (enforce isolation when a sandbox is available, otherwise refuse to run)',
  modeNone: 'No isolation (bare process, dangerous, trusted environments only)',
  modeDescription:
    "auto: through the code-sandbox service (Linux bubblewrap / macOS sandbox-exec), code is confined to “the workspace + this run's temporary directory”, has no network by default, and only allowlisted environment variables are passed; with no sandbox backend available, it refuses to run (fail-closed). none: falls back to a bare process without isolation, warning every time. Note: v1 leaves reads open (interpreters need system libraries); it guards against writing outside the workspace, exfiltrating over the network and tampering with the system, not against reading other files on this machine.",
  networkLabel: 'Child process network',
  networkDeny: 'No network (recommended)',
  networkAllow: 'Allowed (coarse, cannot filter by domain)',
  networkDescription:
    'Only takes effect in auto mode. deny: network access from the script (including fetch) fails. allow: opens the child process network (cannot be filtered by a domain allowlist).',
});

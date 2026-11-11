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
    'Working directory for scripts, as a storage URI such as workspace:/ or tmp:/run; relative paths are resolved under workspace:/.',
  sandboxLabel: 'Code sandbox',
  modeLabel: 'Isolation mode',
  modeAuto: 'Automatic (enforce isolation when a sandbox is available, otherwise refuse to run)',
  modeNone: 'No isolation (bare process, dangerous, trusted environments only)',
  modeDescription:
    "“Automatic” runs in an OS sandbox that may only write the working directory and this run's temporary directory, with no network by default; “No isolation” runs directly, with a warning when the plugin starts. The sandbox does not restrict reading files on this machine.",
  networkLabel: 'Child process network',
  networkDeny: 'No network (recommended)',
  networkAllow: 'Allowed (coarse, cannot filter by domain)',
  networkDescription: 'Only takes effect when “Isolation mode” is “Automatic”.',
});

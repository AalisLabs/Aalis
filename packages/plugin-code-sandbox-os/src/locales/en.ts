import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  none: 'No OS sandbox is available; code_runner in auto mode will refuse to run code',
  noPlatform:
    'This platform ({platform}) has no OS sandbox backend: to use the sandbox, run Aalis on macOS, Linux or WSL',
  fixSeatbelt: 'sandbox-exec ships with macOS; make sure /usr/bin/sandbox-exec can run, then reload this plugin',
  fixBwrap:
    'Install bubblewrap (bwrap) and enable unprivileged user namespaces; inside a container, /proc must also be mountable. Reload this plugin after fixing it',
  probeFailed: '{fix}. Probing {cmd} failed: {reason}',
  killed: 'terminated by signal {signal} (including the 5-second timeout)',
  exitCode: 'exit code {code}',
  available: 'OS sandbox available ({backend})',
});

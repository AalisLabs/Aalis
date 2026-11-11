import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Laya trigger judging',
  triggerLabel: 'Laya model',
  thresholdLabel: 'Reply threshold',
  thresholdDescription:
    'Reply when logit ≥ the threshold. Empty = use the model threshold returned by the sidecar (given with the model version).',
  triggerOnAtLabel: 'Detect @ mentions',
  triggerOnAtDescription:
    'An @ to the assistant counts as a mention (as do pokes and its name). A mention does not force a reply; the model decides. When judging is unavailable, it only replies to mentions.',
  triggerOnPokeLabel: 'Pokes count as mentions',
  triggerNamesLabel: 'Mention aliases (comma- or newline-separated)',
  muteKeywordsLabel: 'Mute keywords (comma- or newline-separated)',
  muteTimeSecondsLabel: 'Mute duration on keyword match (seconds)',
  mediaWaitMsLabel: 'Attachment recognition wait limit (ms)',
  mediaWaitMsDescription:
    'Messages with images or other attachments wait for recognition to write their descriptions before going to the model; on timeout judging goes ahead and recognition continues in the background.',
  endpointLabel: 'Sidecar address',
  sidecarDirLabel: 'Sidecar directory',
  sidecarDirDescription:
    'Absolute path of the directory containing the laya-listener sidecar. When set, this plugin starts and manages the sidecar process, and the sidecar address must be http://127.0.0.1:<port>. Empty = the sidecar runs externally and is only reached at the sidecar address.',
  timeoutMsLabel: 'Request timeout (ms)',
  timeoutMsDescription:
    'Includes reading the whole response body. A timeout counts as one failure, and this message falls back to replying only when mentioned.',
  historyRowsLabel: 'History rows',
  historyRowsDescription:
    'Number of rows in the window, counting only user / assistant rows whose content is a string; the most recent this many are taken.',
  endpointNotHttp: 'plugin-trigger-laya config error: endpoint must be an HTTP address',
  endpointQuery:
    'plugin-trigger-laya config error: endpoint cannot contain a query string or fragment (anything after ? or #): the plugin appends paths to it',
  inactive:
    'Laya trigger judging is not in effect (the active trigger plugin is “{label}”), so the sidecar is not checked; to enable it, point trigger to @aalis/plugin-trigger-laya under servicePreferences in the configuration file',
  inactiveNone:
    'Laya trigger judging is not in effect (no trigger plugin is active), so the sidecar is not checked; to enable it, point trigger to @aalis/plugin-trigger-laya under servicePreferences in the configuration file',
  active: 'Laya trigger judging is in effect: {parts}',
  fallbackNote: '{problems}; judging falls back to replying only when mentioned',
  unavailable: 'judging unavailable ({reason})',
  stale: 'judging was unavailable last time ({reason}) and no request has confirmed the recovery yet',
  circuitOpen: 'the sidecar failed {count} times in a row, last time: {why}; circuit open, retrying in {seconds}s',
  timeout: 'timed out ({ms}ms)',
  notJson: 'the response is not JSON',
  badLogit: 'the logit in the response is not a finite number',
  badThreshold: 'the threshold is not a finite number',
  noMemory: 'memory is absent, so there is no history window',
  memoryAbsent: 'memory is absent',
  online: 'sidecar online (version {version})',
  onlineManaged: 'sidecar online (version {version}, managed by this plugin)',
  unreachable: 'sidecar unreachable ({error})',
  starting:
    'sidecar starting ({seconds}s so far); until it is ready, judging falls back to replying only when mentioned',
  restartingFor:
    'sidecar restarting ({seconds}s so far; it exited {count, plural, one {once} other {# times in a row}} before)',
  restarting: '{reason}, restarting in {wait}s ({count} in a row)',
  external:
    'the sidecar is not managed by this plugin: another sidecar was already running on the port before the first launch; to have this plugin manage it, stop that one first (uninstall it if it is a system service), then restart Aalis or switch the trigger preference away and back',
  blind:
    '{count} of the last {total} messages with images had only image pointers and no content descriptions when judged: “Image recognition → Recognize images on arrival” is off in “Multimodal media recognition” (vision.recognizeOnArrival), or no recognition model is available',
  notManaged: 'not managing the sidecar: {problem}',
  dirNotAbsolute: 'sidecarDir must be an absolute path (currently: {dir})',
  badEndpoint:
    'to manage the sidecar, its address must be http://127.0.0.1:<port> (no path): the sidecar only listens locally and takes the port from here (currently: {endpoint})',
  noProcess: 'the process service is absent, so the sidecar cannot be launched',
  spawnFailed: 'launching the sidecar failed ({error})',
  exited: 'the sidecar exited ({why})',
  exitedTail: 'the sidecar exited ({why}; last line of stderr: {tail})',
  startupTimeout: 'startup timed out: not ready within {seconds}s',
  killedBy: 'terminated by signal {signal}',
  exitCode: 'exit code {code}',
  exitCodeMeaning: 'exit code {code}, {meaning}',
  exit2: 'startup failed: loading the model or the golden self-check failed, or the arguments or script are wrong',
  exit3: 'binding the port failed',
  exit4: 'self-healing exit: inference failed repeatedly',
  exit5: 'the parent process is not the one given by --parent-pid',
  restartIn: '{reason}, restarting in {seconds}s',
  thresholdUnset: 'The model threshold returned by the sidecar',
});

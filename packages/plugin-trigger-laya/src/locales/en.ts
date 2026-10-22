import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
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
  restartingFor: 'sidecar restarting ({seconds}s so far; it failed to start {count} times in a row before)',
  restarting: '{reason}, restarting in {wait}s ({count} in a row)',
  external:
    'the sidecar is not managed by this plugin: another sidecar was already running on the port before the first launch; to have this plugin manage it, stop that one first (uninstall it if it is a system service), then restart Aalis or switch the trigger preference away and back',
  blind:
    '{count} of the last {total} messages with images had only image pointers and no content descriptions when judged: media has not enabled recognizing images on arrival (vision.recognizeOnArrival), or no recognition model is available',
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

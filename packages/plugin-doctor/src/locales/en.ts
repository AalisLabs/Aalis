import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'System diagnostics',
  runNow: 'Run now',
  ran: 'Diagnostics finished: {ok, number} passed, {warn, plural, one {# warning} other {# warnings}}, {error, plural, one {# error} other {# errors}}',
  lastRun: 'Last run',
  time: 'Time',
  notRunYet: 'Not run yet',
  countWarn: 'Warnings',
  countError: 'Errors',
  levelOk: 'Passed',
  levelWarn: 'Warning',
  levelError: 'Error',
  results: 'Diagnostic results',
  noResults: 'No diagnostics have run yet',
  columnLevel: 'Level',
  columnCategory: 'Category',
  columnCheck: 'Check',
  columnMessage: 'Message',
  columnDetail: 'Details',
  categoryEnv: 'Environment',
  categoryFilesystem: 'File system',
  categoryPlugins: 'Plugins',
  categoryConfig: 'Config',
  categoryService: 'Service',
  categoryOther: 'Other',
  noticeErrorsWarnings:
    'Diagnostics found {error, plural, one {# error} other {# errors}} and {warn, plural, one {# warning} other {# warnings}}',
  noticeErrors: 'Diagnostics found {error, plural, one {# error} other {# errors}}',
  noticeWarnings: 'Diagnostics found {warn, plural, one {# warning} other {# warnings}}',
  commandDescription: 'Run system diagnostics. Covers the environment, file system and plugin status',
  checkThrew: 'Check {id} threw an exception',
  nodeTooOld:
    'Node 24.15.0 or later is required; see https://aalis.acenyan.com/guide/first-run#upgrade-node for how to upgrade',
  platform: 'Platform {platform}',
  noPluginManager: 'PluginManagerService is unavailable; plugin checks skipped',
  pluginsActive: '{active, number} of {total, plural, one {# plugin} other {# plugins}} active',
  noErrored: 'No plugins in the error state',
  errored: '{count, plural, one {# plugin is} other {# plugins are}} in error (activation failed)',
  noLacking: 'No plugins missing services',
  lacking: '{count, plural, one {# plugin is} other {# plugins are}} missing services and not ready',
  waiting: '{count, plural, one {# plugin is} other {# plugins are}} waiting for other plugins to start',
  noSlow: 'No plugins over the activation threshold',
  slow: '{count, plural, one {# plugin has} other {# plugins have}} been activating past the threshold, still running in the background',
  slowHint:
    'Just wait for it to finish; if it takes long, check its logs (usually it is waiting on the network or an external service); disabling and re-enabling it retries',
  lingering:
    '{count, plural, one {# plugin has an old instance} other {# plugins have old instances}} still not stopped after the grace period',
  lingeringLine: 'Waiting for the old instance of {id} to stop',
  lingeringHint:
    'Once it stops, things continue toward the target state; if it never stops, check its logs (usually cleanup is waiting on the network or an external process); restarting the process resolves it',
  preferenceMissed: 'The preference {preferred} for service {name} is not among its providers and has no effect',
  pluginPreferenceMissed:
    "Plugin {plugin}'s preference {preferred} for service {name} is not among its providers and has no effect",
  inUse: 'Actually in use: {label} ({id})',
  inUseId: 'Actually in use: {id}',
  noProvider: 'This service has no provider right now',
  fixPreference:
    'Choose another preference: servicePreferences.{name} in the config file, or the service preferences under WebUI Settings “System”; to use the original one, enable the plugin that provides {preferred}',
  fixPluginPreference:
    'Choose another preference: the service preferences in the WebUI plugin details ({plugin}), or pluginServicePreferences in the config file; to use the original one, enable the plugin that provides {preferred}',
  preferencesInEffect: 'All service preferences are in effect',
  pluginLine: '{instance}: {reason}',
  reportTitle: '**System diagnostics — {at, datetime, medium}**',
  reportSummary:
    'Summary: {ok, number} passed, {warn, plural, one {# warning} other {# warnings}}, {error, plural, one {# error} other {# errors}}',
  reportErrors: '__Errors__',
  reportWarnings: '__Warnings__',
  reportPassed: '__Passed__',
  reportCheck: '- {check, code} — {message}',
  reportDetail: '    {detail}',
});

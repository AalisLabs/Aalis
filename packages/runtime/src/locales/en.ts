import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  configFile: 'config file',
  secretsFile: 'secrets file',
  yamlSyntax: 'syntax error',
  yamlPosition: '{code} (line {line}, column {col})',
  saveRefused:
    'The {file} has external changes that have not taken effect yet; this save was refused so they are not overwritten ({path})',
  unsafePluginId: 'Invalid plugin id: {id}',
  notMapping: 'The config of plugin {instance} must be a mapping, not null, an array or a scalar',
  sectionNotMapping: '{at} in the config document is not a mapping (got {kind})',
  sectionNotList: '{at} in the config document is not a list (got {kind})',
  entryNotString: '{at} in the config document is not a string (got {kind})',
  noDefinition:
    'Plugin {instance} does not exist, and no definition of the same module is available to create it (the module must be registered and declare reusable)',
  plainSecret:
    'setPluginConfig only accepts the document form: raw values cannot be written to the secret fields of {instance} ({paths, list}); use applyPluginConfig to change the config',
  secretAt: '{path} (key {key})',
  danglingRejected:
    '{instance} references secrets missing from secrets.yaml: {items, list}; enter the values again, or add these keys to secrets.yaml first',
  dangling:
    '{instance} references secrets missing from secrets.yaml: {items, list}; plugins that read their config with parseConfig fail to activate. Enter the values again in the WebUI, or add these keys to secrets.yaml',
  secretsResolved: 'All secrets referenced by the config are in secrets.yaml',
});

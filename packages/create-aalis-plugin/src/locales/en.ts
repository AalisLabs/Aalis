import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  nonTty: 'This is not an interactive terminal (stdin is not a TTY), so the questions cannot be asked. Use instead:',
  nonTtyYes: '  create-aalis-plugin <package name> --yes    # all defaults (tool template)',
  badLanguage: '--lang only accepts zh-CN or en (the source language of the plugin), not “{value}”',
  packageNamePrompt: 'Package name (such as my-plugin or @scope/my-plugin)',
  sourceLanguagePrompt: 'Source language (zh-CN or en)',
  displayNamePrompt: 'Display name',
  toolPrompt: 'Register an AI tool?',
  commandPrompt: 'Register a slash command?',
  pagePrompt: 'Provide a WebUI page?',
  framePrompt: 'Give the page its own frontend?',
  sessionSettingPrompt: 'Declare a setting that can be set per session?',
  warning: '  Note: {error}',
  yesOrNo: 'Enter y or n.',
  badSourceLanguage: 'Only zh-CN or en is accepted.',
  nameEmpty: 'The name cannot be empty.',
  nameTooLong: 'The name is too long (over 214 characters).',
  nameSpace: 'The name cannot contain spaces.',
  nameUppercase: 'The name must be all lowercase (an npm package name rule, such as my-plugin).',
  scopeFormat: 'A scoped package name is written @scope/name.',
  scopeInvalid:
    'The scope “{scope}” is invalid (it must start with a lowercase letter or digit and contain only a-z 0-9 . _ -).',
  nameLeadingDot: 'The name cannot start with . or _.',
  nameChars:
    'The name may contain only lowercase letters, digits, - . and _, and must start with a letter or digit (such as my-plugin).',
  badPackageName: 'Invalid package name “{name}”: {error}',
  dirExists: 'The directory already exists: {dir}; choose another plugin name or move that directory away first',
  versionUnreachable: 'Cannot find the latest version of {pkg}: cannot reach {url} ({error})',
  versionStatus: 'Cannot find the latest version of {pkg}: {url} answered {status}',
  versionNotJson: 'Cannot find the latest version of {pkg}: the response from {url} is not JSON ({error})',
  versionMissing: 'Cannot find the latest version of {pkg}: the response from {url} has no version',
  registryHint:
    'Check the network and proxy and retry, or use --registry <registry address> to pick an npm registry you can reach (npm config get registry shows the one this machine uses).',
  generated: 'Generated the plugin skeleton: {dir}',
  nextSteps: 'Next steps:',
  installLinks:
    'To install it into an Aalis project, run npm install --install-links <path of this directory> in the project directory,',
  installNpmrc:
    "and add the line install-links=true to the project's .npmrc (otherwise the next plain npm install turns it back into a symlink);",
  installPack:
    'or run npm pack in this directory, then npm install <path of the generated .tgz> in the project directory. It cannot be installed as a symlink:',
  installSecondCore:
    'the @aalis/core in the devDependencies of this directory would become a second copy in the process, and the plugin would be refused.',
  installLoad:
    'After installing, restart the instance or use Rescan plugin folders in the WebUI plugin area to load the plugin (plugins are enabled by default; to disable one, add its package name to disabledPlugins).',
});

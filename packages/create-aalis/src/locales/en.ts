import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  header: '=== Create an Aalis project ===',
  uiLanguageTitle: 'Installer language',
  projectName: 'Project directory name',
  dirNotEmpty: 'The directory already exists and is not empty: {dir} (add --force to write into it anyway)',
  advancedHint:
    'Installs the usual set by default. To choose the template tier, memory backend, embedding or vector store, run again with --advanced.',
  tierTitle: 'Template tier',
  tierBare: 'bare: only core and runtime (a starting point for full customization)',
  tierMinimal:
    'minimal: the smallest chat instance (gateway, agent, permissions, sessions, chat model, platforms and memory backend)',
  tierStandard:
    'standard: the usual set (minimal plus personas, memory enhancements, tools, scheduling, skills, diagnostics and more; semantic memory optional)',
  tierFull: 'full: every published official plugin (looked up on npm live, including web search)',
  ollamaFound: 'Found Ollama ({base}); it works without a key.',
  ollamaFoundNoChat:
    'Found Ollama ({base}); it works without a key, but it has no chat model yet: ollama pull a chat model before starting.',
  chatTitle: 'Chat model',
  localNoKey: '{name} (runs locally, no key needed)',
  platformsTitle: 'Platforms (choose any)',
  platformCli: 'CLI terminal',
  platformWebui: 'WebUI admin console',
  platformOnebot: 'OneBot (QQ and others)',
  memoryTitle: 'Memory backend',
  memorySqlite: 'SQLite (local file, recommended)',
  memoryInMemory: 'In memory (lost on restart)',
  memoryMongodb: 'MongoDB (needs an external service)',
  semanticQuestion:
    'Add long-term semantic memory? It finds things talked about long ago by meaning and needs an embedding model',
  embeddingTitle: 'Embedding provider',
  vectorstoreTitle: 'Vector store',
  vectorstoreFlat: 'Flat (built in, no dependencies)',
  vectorstoreLancedb: 'LanceDB (high performance)',
  pasteKey: 'Paste the {key} for {plugin} (input is hidden; press Enter to skip)',
  languagesTitle: "Aalis's language list (earlier ones are used first; missing translations fall back to the next)",
  languageChain: "Aalis's language list: {chain}. Use this order?",
  packTitle: 'Found language packs for {name} ({tag}). Install one as well?',
  packSkip: 'Do not install',
  packSearchFailed: 'Cannot reach {registry}, so no language pack for {name} ({tag}) could be searched for',
  packSearchEmpty: 'No language pack for {name} ({tag}) was found on {registry}',
  packSearchEmptyMirror:
    'No language pack for {name} ({tag}) was found on {registry}; this registry may not support search, so you can retry with --registry https://registry.npmjs.org',
  languageUnprovided: 'No plugin provides {name} ({tag}), so it is left out of the language list',
  badLanguage: '“{item}” in --lang is not a language tag: write tags such as zh-CN and en, separated by commas',
  optionsTitle: '{title}:',
  chooseOne: 'Choose one (number; Enter = {shown}): ',
  chooseMany: 'Choose any (numbers separated by commas or spaces; Enter = {shown}): ',
  orderPrompt: 'Enter numbers in order of priority; the rest follow in their current order (Enter = keep this order): ',
  warning: '  Note: {error}',
  yesOrNo: 'Enter y or n.',
  badToken: 'Cannot read “{token}”: enter numbers only (such as 1,2 or 1 2), without letters or symbols.',
  outOfRange: 'Number {n} is out of range (1-{count}).',
  duplicate: 'Number {n} is repeated.',
  singleChoice: 'This is a single choice; enter just one number.',
  nameEmpty: 'The name cannot be empty.',
  nameTooLong: 'The name is too long (over 214 characters).',
  nameSpace: 'The name cannot contain spaces.',
  nameUppercase: 'The name must be all lowercase (an npm package name rule, such as my-bot).',
  scopeFormat: 'A scoped package name is written @scope/name.',
  scopeInvalid:
    'The scope “{scope}” is invalid (it must start with a lowercase letter or digit and contain only a-z 0-9 . _ -).',
  nameLeadingDot: 'The name cannot start with . or _.',
  nameChars:
    'The name may contain only lowercase letters, digits, - . and _, and must start with a letter or digit (such as my-bot).',
  badProjectName: 'Invalid project name “{name}”: {error}',
  unknownTier: 'Unknown template tier “{tier}”; enter bare / minimal / standard / full.',
  nodeTooOld: 'Aalis needs Node.js {need} or later; this is {current}.',
  upgradeNode: 'How to upgrade: {url}',
  badOllamaHost:
    'OLLAMA_HOST “{value}” is not a valid address: write host:port (such as 127.0.0.1:11434) or a full address (such as http://host:port)',
  pullChat: 'ollama pull <chat model name>    # pull a chat model first',
  pullEmbedding: 'ollama pull {model}    # the embedding model for semantic memory',
  nonTty:
    'This is not an interactive terminal (stdin is not a TTY), so the questions cannot be asked. Use a non-interactive form instead:',
  nonTtyYes:
    '  npm create aalis@latest <name> -- --yes             # all defaults: the chat model and semantic memory use the local Ollama when found, otherwise DeepSeek without semantic memory; platforms are CLI and WebUI',
  nonTtyTier:
    '  npm create aalis@latest <name> -- --tier minimal    # the defaults of one tier: bare, minimal, standard, full',
  nonTtyKeys:
    'Fill in keys for the plugins that need them in home/aalis.config.yaml after generating, or in the WebUI plugin area after starting.',
  cancelled: 'Cancelled; no files were generated.',
  catalogOffline: '(Cannot reach npm; the full tier falls back to the offline list)',
  catalogEmpty:
    '(The plugin search on {registry} returned no official plugins, so the full tier installs only the standard tier plugins and every option of each question; this registry may not support search, so you can retry with --registry https://registry.npmjs.org)',
  generated: 'Generated the project: {dir} ({count, plural, one {# plugin} other {# plugins}} enabled)',
  installing: 'Running npm install (this may take a few minutes)…',
  nextSteps: 'Next steps:',
  indented: '  {line}',
  unfilledKeys: 'Keys not filled in yet (their plugins cannot start until they are):',
  unfilledKey: '  {key} for {plugin}',
  keyWhereWebui:
    '  Where: open the plugin in the WebUI plugin area after starting, or fill in its section under plugins in home/aalis.config.yaml',
  keyWhere: '  Where: fill in its section under plugins in home/aalis.config.yaml',
  fullOthers:
    'Other plugins that need credentials, addresses or paths: after starting, Needs attention in the WebUI lists them as needing configuration or failed; configure them from there.',
  firstRun: 'First run: {url}',
  morePluginsWebui:
    'More plugins: search for and install them in the WebUI plugin market after starting; or npm install @aalis/plugin-<name>, then restart the instance or use Rescan plugin folders in the plugin area.',
  morePlugins: 'More plugins: npm install @aalis/plugin-<name>; they load after you restart the instance.',
  installFailed: 'npm install failed: {reason}',
  someDependency: 'some dependency',
  diskReason: 'Not enough disk space (ENOSPC).',
  diskFix: '  Free up some space and install again.',
  permissionReason: 'No write permission (EACCES).',
  permissionFix:
    '  Do not retry with sudo: give the project directory and the npm cache directory (see npm config get cache) back to the current user,',
  permissionExample:
    '  for example sudo chown -R "$(whoami)" <directory>; if it reports a global directory, use Node installed with nvm, or npm config set prefix ~/.npm-global.',
  platformReason:
    'The dependency {pkg} does not support the operating system or CPU architecture of this machine (EBADPLATFORM).',
  platformFix: '  Generate again with --advanced and replace the plugin that uses it (npm ls {pkg} shows which).',
  peerReason: 'npm cannot resolve the dependency versions (ERESOLVE).',
  peerFix:
    '  This should not happen in a newly generated project: please attach the log above to an issue at https://github.com/AalisLabs/Aalis/issues',
  browserReason: 'Downloading the browser failed: plugins that use a browser download Chrome when installed.',
  browserMirror:
    '  Set mirror addresses and install again: PUPPETEER_CHROME_DOWNLOAD_BASE_URL=<mirror> PUPPETEER_CHROME_HEADLESS_SHELL_DOWNLOAD_BASE_URL=<mirror> npm install;',
  browserSkip:
    '  or leave out the plugins that use a browser for now: remove them from dependencies in package.json and npm install again (npm ls puppeteer shows which).',
  nativeReason: 'Building the native module {pkg} failed: this machine lacks C/C++ build tools.',
  nativeTools:
    '  Install build tools and install again: on macOS run xcode-select --install; on Linux install build-essential and python3; on Windows install the "Desktop development with C++" workload of Visual Studio.',
  nativeReplace: '  Or generate again with --advanced and replace the plugin that uses it (npm ls {pkg} shows which).',
  missingReason: 'The registry does not have this package or version ({code}).',
  missingFix:
    '  Check the package name and version; on a mirror registry a version just published may not be synced yet, so retry later or switch back to the official registry for now: npm install --registry=https://registry.npmjs.org.',
  networkReason: 'Cannot reach the npm registry ({code}).',
  networkFix:
    '  Check the network and proxy settings and retry; if the default registry is unreachable, switch to another: npm config set registry <registry address>, then npm install.',
  unknownReason: 'See the npm error above for the reason.',
  retry: 'Retry: cd {dir} && npm install',
  npmLog: 'Full npm log: {log}',
  troubleshooting: 'Install troubleshooting: {url}',
});

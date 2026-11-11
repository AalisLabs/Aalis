import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Package manager',
  emptyName: 'The package name must be a non-empty string',
  badName: 'Invalid package name: {name}',
  badVersion: 'Invalid version: {name}@{version}',
  noTargets: 'No update targets given',
  duplicateTarget: 'The same package was given more than once: {name}',
  tooManyTargets: 'Too many update targets: the arguments exceed {budget} bytes in total; submit them in batches',
  npmDisk: 'Not enough disk space (ENOSPC): free some space and retry',
  npmPermission:
    'No write permission (EACCES): give the project directory and the npm cache directory (see npm config get cache) back to the user running Aalis, then retry; do not use sudo',
  npmPlatform:
    'Dependency {pkg} does not support the system or CPU architecture of this machine (EBADPLATFORM); this plugin cannot be installed here',
  npmPlatformUnknown:
    'A dependency does not support the system or CPU architecture of this machine (EBADPLATFORM); this plugin cannot be installed here',
  npmPeer: 'Peer dependency conflict (market installs do not use legacy-peer-deps from .npmrc): {conflicts}',
  npmBrowser:
    'Downloading the browser failed: this plugin downloads Chrome while installing. Set a mirror (environment variable PUPPETEER_CHROME_DOWNLOAD_BASE_URL) in the environment Aalis is launched from, relaunch Aalis and install again (an in-app restart keeps the previous environment variables)',
  npmNative:
    'Native module {pkg} failed to compile: this machine lacks C/C++ build tools. On macOS run xcode-select --install; on Linux install build-essential and python3; on Windows install Visual Studio “Desktop development with C++”; then retry',
  npmNativeUnknown:
    'A native module failed to compile: this machine lacks C/C++ build tools. On macOS run xcode-select --install; on Linux install build-essential and python3; on Windows install Visual Studio “Desktop development with C++”; then retry',
  npmMissing:
    'The registry has no such package or version ({code}): check the name and version; if you use a mirror it may not have synced yet, so retry later',
  npmNetwork:
    'Cannot reach the npm registry ({code}): check the network and proxy and retry; if the default registry is unreachable, run npm config set registry <registry URL> in a terminal to switch',
  npmOther:
    'npm failed: {error}. The full output is in the logs; see https://aalis.acenyan.com/guide/troubleshooting for common causes and fixes',
  needsPeer: '{dependent} needs {peer}',
  busy: 'A package operation is in progress ({operation}); retry in a moment',
  closing: 'The package manager is shutting down',
  abortedNoChange: 'Stopped; nothing was changed',
  interrupted:
    'Stopped before it took effect: package.json and the lockfile were restored to how they were before; node_modules may not match them, so run npm install in the install directory to bring it in line (any later install, uninstall or update from the market does that too)',
  interruptedRestoreFailed:
    'Stopped, but these files could not be restored to how they were before and must be restored by hand: {items, list}; node_modules may not match package.json and the lockfile, so after restoring them run npm install in the install directory to bring it in line',
  restoreFailedItem: '{path} ({error})',
  snapshotUnreadable:
    'Nothing changed: {path} exists but could not be read; npm is not run without its pre-operation copy',
  opUpdate: 'updating {names, list}',
  opInstall: 'installing {name}',
  opUninstall: 'uninstalling {name}',
  installedErrored: 'Installed {target}, but activation failed and it is now in the error state ({error})',
  seeLogs: 'see the logs for details',
  installedActivating:
    'Installed {target}; it is still activating (past the slow-activation threshold, moved to the background); see the plugin list for the result',
  installedPending: 'Installed {target}; not active yet, waiting for its required dependencies',
  installedLoaded: 'Installed and loaded: {target}',
  installedNotLoaded:
    'Installed into {where}, but although it declares itself a plugin it was not loaded; check its keywords, its entry export, and that the name in its definition matches the package name',
  installedNameTakenByHost:
    'Installed {target}, but the host has already registered a plugin of the same name directly, so this package was not loaded',
  installedNonPlugin: 'Installed {target} (not a plugin package, so it does not appear in the plugin list)',
  workspaceInstall:
    'The root dependencies use the workspace: protocol, so npm install is refused here (it would write package-lock.json and break the pnpm workspace)',
  workspaceUpdate: 'The root dependencies use the workspace: protocol, so npm install is refused here',
  noRootPackage: 'Cannot read the root package.json: {path}',
  notUpdatable:
    'These packages are not root dependencies (another plugin brought them in) or are not from the registry, so updating them alone would install a second copy; update the plugins that bring them in instead: {names, list}',
  downgradeItem: '{name} (installed {installed} → target {version})',
  unknown: 'unknown',
  notUpgrade:
    'These target versions are not higher than the installed ones (or the installed version cannot be read), so the update would be a downgrade and was refused: {items, list}',
  preflightRejected:
    'The dependency dry run did not pass; no files were changed. If it is a peer version requirement, select the depended-on packages too and retry.',
  preflightFailed: 'The dependency dry run could not run: {error}',
  installFailedRetry: 'Installation failed (the project was not restarted; you can retry): {error}',
  updated: 'Updated {specs, list}; restarting…',
  updatedRestartUnavailable:
    'Updated {specs, list}, but the app cannot restart itself ({error}); restart it by hand for the update to take effect',
  noPackageJson:
    'Cannot read the package.json of {name}, so the market cannot tell what it is and will not uninstall it; if you are sure, run npm uninstall {name} in the project directory and restart',
  lifeline:
    '{name} is hosting the market and management interface itself; uninstalling it would make this page unavailable at once, leaving only the terminal to recover. To switch implementations, install the replacement and switch to it in the service preferences under Settings “System” first, then come back and uninstall this one.',
  originWorkspace: 'it is a local source package in the workspace; remove it through git',
  originLink:
    'it points to a local directory through file:/link:; change that source and the dependency declaration to remove it',
  originGit:
    'it was installed from git, a URL or a user/repo shorthand; change the dependency declaration to remove it',
  originAlias: 'it is an npm: alias of another package; change the dependency declaration to remove it',
  originTransitive:
    'it is not a root dependency (another plugin brought it in) and npm prunes it along with the plugin that brought it in',
  notFromMarket: '{name} was not installed through the market: {why}.',
  breaksDependents:
    'Uninstalling would break dependencies: these plugins depend on services this plugin provides and no other plugin provides them: {dependents, list}. Disable them first, or enable or install an alternative provider.',
  uninstalledConfigUnsaved:
    'Plugin {name} was uninstalled (removed from the root dependencies and node_modules), but the config file could not be written ({error}): if needed, delete its config section and disabled flag from the config file by hand.',
  uninstalledFlagUnsaved:
    'Plugin {name} was uninstalled (removed from the root dependencies and node_modules), but the config file could not be written ({error}): if needed, delete its disabled flag from the config file by hand.',
  uninstalledConfigRemoved:
    'Plugin {name} was uninstalled (removed from the root dependencies and node_modules). Its config was deleted from the config file, along with the secrets only it used; data written under state/ in the data directory and elsewhere is not deleted, so clean it up by hand if needed.',
  uninstalledConfigKept:
    'Plugin {name} was uninstalled (removed from the root dependencies and node_modules). Its config stays in the config file, so it starts with the same config if reinstalled; data written under state/ in the data directory and elsewhere is not deleted, so clean it up by hand if needed.',
  uninstalledNameTakenByHost:
    '{name} was uninstalled (removed from the root dependencies and node_modules). The host registered a plugin of the same name directly, so this package was never loaded; that plugin and the config file were left unchanged.',
  kindCore: 'core',
  kindRuntime: 'host',
  kindApi: 'service contract',
  kindSchema: 'data schema',
  kindUtil: 'utility library',
  kindOther: 'non-plugin package',
  installUnmarked:
    '{name} ({kind}) is not a plugin that can be installed or uninstalled; the market does not install it. The market only installs packages with the aalis-plugin / aalis-interface keyword.',
  installBundled:
    '{name} ({kind}) is not a plugin that can be installed or uninstalled; the market does not install it. It is put in place by the scaffold or by the plugins that depend on it; to upgrade the installed version, select it in the market and submit with “Update selected”.',
  uninstallVital:
    '{name} ({kind}) is not a plugin that can be installed or uninstalled; the market does not uninstall it. Without it the instance cannot start and the market goes away too, leaving only the terminal to recover; if you really mean it, run npm uninstall by hand.',
  uninstallPruned:
    '{name} ({kind}) is not a plugin that can be installed or uninstalled; the market does not uninstall it. npm prunes it automatically along with the plugins that depend on it; to remove it on its own, run npm uninstall by hand.',
});

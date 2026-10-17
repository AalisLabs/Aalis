import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  kindCore: 'core',
  kindRuntime: 'host',
  kindApi: 'service contract',
  kindSchema: 'data schema',
  kindUtil: 'utility library',
  kindOther: 'non-plugin package',
  installUnmarked:
    '{name} ({kind}) is not a plugin that can be installed or uninstalled; the marketplace does not install it. The marketplace only installs packages with the aalis-plugin / aalis-interface keyword.',
  installBundled:
    '{name} ({kind}) is not a plugin that can be installed or uninstalled; the marketplace does not install it. It is put in place by the scaffold or by the plugins that depend on it; to upgrade the installed version, select it in the marketplace and submit with “Update selected”.',
  uninstallVital:
    '{name} ({kind}) is not a plugin that can be installed or uninstalled; the marketplace does not uninstall it. Without it the instance cannot start and the marketplace goes away too, leaving only the terminal to recover; if you really mean it, run npm uninstall by hand.',
  uninstallPruned:
    '{name} ({kind}) is not a plugin that can be installed or uninstalled; the marketplace does not uninstall it. npm prunes it automatically along with the plugins that depend on it; to remove it on its own, run npm uninstall by hand.',
});

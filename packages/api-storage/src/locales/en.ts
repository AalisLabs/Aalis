import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  hostPath:
    'Enter a storage URI here (<root>:/<path>, e.g. {example}), not a local path "{path}"; to use a directory outside the storage roots, first add a root pointing to it under roots in "Local storage roots" and turn on its "Allow writes"; file tools can access that root too',
});

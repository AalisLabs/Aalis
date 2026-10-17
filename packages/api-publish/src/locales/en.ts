import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  pathEmpty: 'The path is empty',
  pathTooLong: 'The path is too long',
  pathSlashEnds: 'The path starts or ends with a slash',
  pathTooDeep: 'The path has too many levels',
  pathReservedName: 'The path contains a reserved file name',
  pathReservedDir: 'The path uses a reserved directory name',
  pathBadCharacters: 'A path segment contains characters that are not allowed',
  extensionNotAllowed: 'The extension is not on the allowlist',
  htmlNotIndex: 'The only web page allowed is index.html at the root of the work',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'SQLite memory',
  pathLabel: 'Database path',
  pathDescription:
    "Storage URI of the SQLite database file (such as data:/aalis.db; without ':/' the first segment is taken as the storage root name, and a single bare name goes to the data root). When empty it is derived from the instance: the main instance uses data:/aalis.db, and instances with a suffix add it to the file name (such as data:/aalis-b.db for the `:b` instance). Two instances cannot use the same database; the one activated later reports a config error",
  rangeQueryLimitLabel: 'Range query limit',
  rangeQueryLimitDescription:
    'Maximum messages returned by one range query (such as context-window expansion for vector recall). Results beyond the limit are cut off silently',
  crossSessionMaxLimitLabel: 'Cross-session query limit',
  crossSessionMaxLimitDescription:
    'Maximum messages a cross-session recent-messages query may return; larger requests are narrowed to this limit',
  pathUnresolvable: 'Cannot resolve the database path {uri} (check the path config item): {error}',
  nodeTooOld:
    'SQLite failed to open: the current Node ({version}) is too old, Node 24.15.0 or later is required; for how to upgrade see https://aalis.acenyan.com/guide/first-run#upgrade-node',
  openFailedDir:
    'SQLite failed to open (check that the directory {dir} exists and is writable, or choose another location in the path config item): {error}',
  sharedDb:
    'Database file {path} is already used by instance {holder}; two instances cannot share a database: give {instance} another path',
  sharedDbVia:
    'Database file {path} is already used by instance {holder} (opened through the path {via}); two instances cannot share a database: give {instance} another path',
  openFailed: 'SQLite failed to open: {error}',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'MongoDB memory',
  uriDescription:
    'MongoDB connection string (may contain a user name and password; stored in secrets.yaml and not shown back in the WebUI)',
  databaseLabel: 'Database name',
  databaseDescription:
    'The database that stores message history and metadata (in the collection named metadata). When empty it is derived from the home directory and the instance: the main home directory uses aalis, a profile home directory (~/.aalis-<profile>) uses aalis_<profile>, and instances with a suffix add it (such as aalis-b and aalis_<profile>_b for the `:b` instance). Two instances on the same connection string cannot use the same database; the one activated later reports a config error. The database records which home directory it belongs to, and other home directories connecting to it get an error too',
  claimFromLabel: 'Claim database ownership',
  claimFromDescription:
    "Normally left empty. When the database already belongs to another home directory (for example after the home directory moved), first stop that home directory's instance, then fill in its path; when the database has data but no ownership record yet, fill in unowned. One startup moves the ownership to this home directory; remove this item after claiming: a leftover unowned makes every database it points to later skip the “has data” check",
  collectionLabel: 'Collection name',
  collectionDescription: 'Name of the message collection',
  connectTimeoutMsLabel: 'Connect timeout (ms)',
  connectTimeoutMsDescription:
    'Timeout for establishing the connection and for server selection (serverSelection); both use this value',
  rangeQueryLimitLabel: 'Range query limit',
  rangeQueryLimitDescription:
    'Maximum messages returned by one range query (such as context-window expansion for vector recall). Results beyond the limit are cut off silently',
  crossSessionMaxLimitLabel: 'Cross-session query limit',
  crossSessionMaxLimitDescription:
    'Maximum messages a cross-session recent-messages query may return; larger requests are narrowed to this limit',
  databaseTooLong: 'MongoDB database name {database} exceeds the 63-byte limit: give {instance} a shorter database',
  databaseInUse:
    'MongoDB database {database} is already used by instance {holder} (same connection string); two instances cannot share a database: give {instance} another database',
  connectFailed: 'MongoDB connection failed (make sure MongoDB is running and the uri config item is right): {error}',
  unownedData:
    "MongoDB database {database} already has data but no record of which home directory it belongs to. If this is this home directory's data, write claimFrom: unowned in the config of {instance} and restart to claim it; otherwise give it another database",
  ownerRecordBroken:
    "The ownership record of MongoDB database {database} is broken (the entry with namespace {namespace} and key {key} in the metadata collection lacks the home directory or instance). Once you have confirmed this is this home directory's data, write claimFrom: unowned in the config of {instance} and restart to claim it; otherwise give it another database",
  ownedBySibling:
    'MongoDB database {database} belongs to instance {owner} of this home directory; two instances cannot share a database: give {instance} another database. If the instance was renamed and the database should go to {instance}, first stop {owner}, then write claimFrom: {home} and restart to claim it',
  ownedByOtherHome:
    'MongoDB database {database} already belongs to home directory {home} (instance {owner}). If this home directory was moved from there, first stop the instance of that home directory, then write claimFrom: {home} in the config of {instance} and restart to claim it; otherwise give it another database',
});

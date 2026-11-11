import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'MongoDB memory',
  uriDescription:
    'MongoDB connection string (may contain a user name and password; stored in secrets.yaml and not shown back in the WebUI)',
  databaseLabel: 'Database name',
  databaseDescription:
    'The database that stores message history. When empty, it is named from the data directory and the instance (such as aalis or aalis_<profile>); two instances on the same connection cannot share a database.',
  claimFromLabel: 'Claim database ownership',
  claimFromDescription:
    'Normally left empty. When the database already belongs to another data directory, stop the instance there first, then fill in its path; when the database has data but no ownership record, fill in unowned. One startup completes the claim; remove this item afterwards.',
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
    "MongoDB database {database} already has data but no record of which data directory it belongs to. If this is this data directory's data, write claimFrom: unowned in the config of {instance} and restart to claim it; otherwise give it another database",
  ownerRecordBroken:
    "The ownership record of MongoDB database {database} is broken (the entry with namespace {namespace} and key {key} in the metadata collection lacks the data directory or instance). Once you have confirmed this is this data directory's data, write claimFrom: unowned in the config of {instance} and restart to claim it; otherwise give it another database",
  ownedBySibling:
    'MongoDB database {database} belongs to instance {owner} of this data directory; two instances cannot share a database: give {instance} another database. If the instance was renamed and the database should go to {instance}, first stop {owner}, then write claimFrom: {dir} and restart to claim it',
  ownedByOtherDataDir:
    'MongoDB database {database} already belongs to data directory {dir} (instance {owner}). If this data directory was moved from there, first stop the instance of that data directory, then write claimFrom: {dir} in the config of {instance} and restart to claim it; otherwise give it another database',
});

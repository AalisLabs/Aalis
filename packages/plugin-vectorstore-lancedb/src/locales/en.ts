import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'LanceDB vector store',
  pathLabel: 'Database directory',
  pathDescription: 'Storage URI for the LanceDB data (bare names and relative paths also work)',
  tableNameLabel: 'Table name',
  tableNameDescription: 'Name of the vector table',
  optimizeEveryLabel: 'Compaction interval',
  optimizeEveryDescription:
    'Compact in the background after every this many vectors written (merging fragments and reclaiming obsolete data files). Every LanceDB add creates a new fragment and version; without compaction data/ and _versions/ grow without bound and writes get slower and slower; 0 turns it off',
  cleanupRetentionMinutesLabel: 'Data file retention (minutes)',
  cleanupRetentionMinutesDescription:
    'Compaction reclaims obsolete data files older than this many minutes. Newer files (including writes that may be in flight) are always kept, so it is safe for single-process writes. LanceDB keeps 7 days by default, which under frequent compaction lets data/ grow to hundreds of GB — tightening it to minutes brings the database back to its real size. Larger is more conservative and uses more disk.',
  tableNameEmpty: 'tableName cannot be empty',
});

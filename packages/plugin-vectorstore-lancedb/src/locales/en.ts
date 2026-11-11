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
    'Compact in the background after every this many vectors written, merging fragments and reclaiming obsolete data files. 0 turns it off.',
  cleanupRetentionMinutesLabel: 'Data file retention (minutes)',
  cleanupRetentionMinutesDescription:
    'Compaction reclaims obsolete data files older than this many minutes; newer files are always kept. Larger is more conservative and uses more disk.',
  tableNameEmpty: 'tableName cannot be empty',
});

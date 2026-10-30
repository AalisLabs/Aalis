import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Rewind checkpoints',
  rootDirLabel: 'Storage directory',
  rootDirDescription:
    'Storage URI (data:/checkpoints by default). All checkpoint blobs and manifests are written here.',
  maxFileSizeLabel: 'Per-file size limit (bytes)',
  maxFileSizeDescription:
    'Files larger than this get no content snapshot and are only recorded as skipped in the manifest.',
  keepSessionsLabel: 'Sessions to keep',
  keepSessionsDescription:
    'GC threshold. After each turn is committed, if there are more session directories than this, the oldest ones are deleted. 0 turns GC off.',
  keepTurnsLabel: 'Turns to keep per session',
  keepTurnsDescription:
    'After each turn is committed, once this session has more turns than this, the oldest ones are deleted (with their backups), so only the most recent turns can be rewound; a turn that changed no files and only talked still counts. 0 means no limit.',
  coverageLabel: 'Sessions with checkpoints',
  coverageDescription:
    "Which sessions get checkpoints for their turns (rewind relies on them). “By audience” only records in sessions whose audience is just you: WebUI, the terminal and your own IM private chats; group chats and other people's private chats are not recorded, nor is a turn you send into a group from WebUI.",
  coverageOff: 'Off',
  coverageOwnerOnly: 'By audience (when it is just you)',
  coverageAll: 'On',
  rootDirNotUri: 'plugin-checkpoint config error: rootDir is not a storage URI; write it as <root>:/<path>',
  clearType: 'Checkpoints (conversation rewind saves)',
  clearedAll: 'Cleared all checkpoints ({count, plural, one {# session} other {# sessions}})',
  clearedSession: 'Cleared the checkpoints of this session ({count, plural, one {# turn} other {# turns}})',
  noneInSession: 'This session has no checkpoints',
  clearFailed: 'Clearing checkpoints failed: {error}',
  notSnapshotUnreadable: 'Not snapshotted (the original file could not be read; cannot be rewound)',
  notSnapshotDirectory: 'Not snapshotted (a directory, or reading failed)',
  tooLarge: 'File too large ({size} > {max})',
  noCheckpoint: 'The checkpoint does not exist',
  noDeleteByTimestamps: 'The current memory backend does not support deleteMessagesByTimestamps',
  deleteMessagesFailed: 'Deleting messages failed: {error}',
});

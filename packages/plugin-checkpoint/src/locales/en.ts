import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Rewind checkpoints',
  rootDirLabel: 'Storage directory',
  rootDirDescription: 'Where checkpoints are stored, as a storage URI; data:/checkpoints by default.',
  maxFileSizeLabel: 'Per-file size limit (bytes)',
  maxFileSizeDescription: 'Files larger than this get no content snapshot and are only recorded as skipped.',
  keepSessionsLabel: 'Sessions to keep',
  keepSessionsDescription:
    'At most this many sessions keep checkpoints; after each turn is committed, the oldest beyond this are deleted. 0 means no limit.',
  keepTurnsLabel: 'Turns to keep per session',
  keepTurnsDescription:
    'At most this many turns of checkpoints are kept per session; beyond it the oldest turns are deleted (with their backups), so only the most recent turns can be rewound. A turn that only talked still counts. 0 means no limit.',
  coverageLabel: 'Sessions with checkpoints',
  coverageDescription:
    "Which sessions get checkpoints for their turns; rewind relies on them. “By audience” only records in sessions whose audience is just you (WebUI, the terminal and your own private chats); group chats and other people's private chats are not recorded.",
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

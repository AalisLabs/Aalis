import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'File reader',
  maxFileSizeMBLabel: 'Max file size (MB)',
  maxFileSizeMBDescription: 'Largest file size (MB) allowed for uploads. Files over this limit are rejected.',
  autoInlineLimitLabel: 'Auto inline threshold (characters)',
  autoInlineLimitDescription:
    'Extracted text up to this length is put into the message directly, so the model sees it without calling a tool; longer text only gets a file ID and is read on demand. Nothing is inlined in sessions with other people present.',
  toolDefaultMaxLengthLabel: 'read_uploaded_file default truncation',
  toolDefaultMaxLengthDescription:
    'How many characters the uploaded-file reading tool returns when no length is given; 0 means no truncation. Must be a non-negative integer, otherwise it is a configuration error.',
  badToolDefaultMaxLength: 'toolDefaultMaxLength must be a non-negative integer (0 means no truncation)',
  retentionDaysLabel: 'Retention days',
  retentionDaysDescription:
    'Longest number of days uploaded files are kept; older ones are cleaned up (by upload time, uploadedAt). 0 means no time-based cleanup.',
  lruMaxTotalMBLabel: 'Total disk limit (MB)',
  lruMaxTotalMBDescription:
    'When the uploads directory takes more than this limit, files are evicted from oldest to newest by upload time (uploadedAt) until it is back under the limit. 0 means no limit.',
  historyHintEnabledLabel: 'Inject the session file list hint',
  historyHintEnabledDescription:
    "When on and the session has uploaded files, the model is told which files and IDs are available before it is called, with this turn's new uploads marked. Only the most recent {count, number} are listed.",
  recognizeDocImagesLabel: 'Recognize images embedded in documents',
  recognizeDocImagesDescription:
    'When reading DOCX, recognize embedded images and append their descriptions to the end of the text; needs image recognition and is skipped without it. Adds to the first parse time and image recognition cost.',
  maxDocImagesLabel: 'Max images recognized per document',
  maxDocImagesDescription:
    'Embedded images beyond this are not recognized, so that many images do not slow down parsing or add to image recognition cost. 0 is the same as turning recognition off.',
  uploads: 'Uploaded files',
  delete: 'Delete',
  deleteConfirm: 'Delete this uploaded file? The model will no longer be able to read it.',
  notInSession: 'This session has no such file',
  deleted: 'Deleted {name}',
  deleteFailed: 'Failed to delete {name}: {error}',
  noUploads: 'No files uploaded in this session',
  fileName: 'File name',
  size: 'Size (bytes)',
  format: 'Type',
  uploadedAt: 'Uploaded at',
  formatText: 'Text',
  formatUnknown: 'Unknown',
  groupLabel: 'Delete uploaded files',
  groupSummary: 'Delete files uploaded by users',
});

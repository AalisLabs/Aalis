import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'File reader',
  maxFileSizeMBLabel: 'Max file size (MB)',
  maxFileSizeMBDescription: 'Largest file size (MB) allowed for uploads. Files over this limit are rejected.',
  autoInlineLimitLabel: 'Auto inline threshold (characters)',
  autoInlineLimitDescription:
    'If the extracted text is no longer than this, it is inlined into the attachment description (the model sees the full text without calling a tool); otherwise only the ID is attached and the model pulls it with read_uploaded_file when needed. In sessions whose audience includes other people (groups, multi-person rooms, private chats whose other party is not the owner), nothing is inlined; only the file name, ID and size are given.',
  toolDefaultMaxLengthLabel: 'read_uploaded_file default truncation',
  toolDefaultMaxLengthDescription:
    'Default number of characters read_uploaded_file truncates to when the tool is not passed maxLength explicitly, so a huge document is not fed into the LLM context at once and blows the token budget. 0 means no truncation; must be a non-negative integer, negative numbers and decimals are reported as configuration errors.',
  badToolDefaultMaxLength: 'toolDefaultMaxLength must be a non-negative integer (0 means no truncation)',
  retentionDaysLabel: 'Retention days',
  retentionDaysDescription:
    'Longest number of days uploaded files are kept; older ones are cleaned up (by upload time, uploadedAt). 0 means no time-based cleanup.',
  lruMaxTotalMBLabel: 'Total disk limit (MB)',
  lruMaxTotalMBDescription:
    'When the uploads directory takes more than this limit, files are evicted from oldest to newest by upload time (uploadedAt) until it is back under the limit. 0 means no limit.',
  historyHintEnabledLabel: 'Inject the session file list hint',
  historyHintEnabledDescription:
    "When on: if the session has uploaded files, a system hint listing the available files (with IDs) is injected before the LLM call, so the model does not forget earlier uploads. When this turn has new uploads, both this turn's list and the history list are injected (this turn's files marked separately); otherwise only the history list. Only the most recent {count, number} are listed.",
  recognizeDocImagesLabel: 'Recognize images embedded in documents',
  recognizeDocImagesDescription:
    'When reading DOCX, call the media service to recognize embedded images and append the descriptions to the end of the text (requires media/vision; skipped automatically without a media service). Recognition adds to the first parse time and vision token cost; the result is cached with the extracted text.',
  maxDocImagesLabel: 'Max images recognized per document',
  maxDocImagesDescription:
    'Embedded images beyond this are not recognized, so that many images do not slow down parsing or use up vision tokens. 0 is the same as turning recognition off.',
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

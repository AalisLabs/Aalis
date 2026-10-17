import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  restarted: 'Still running when Aalis restarted',
  closed: 'Still running when the tool registry was disabled',
  withdrawn: 'Tool {name} was unregistered',
  noticeCompleted: 'Background task {id} ({tool}) completed in {ms, duration}',
  noticeFailedExit: 'Background task {id} ({tool}) failed with exit code {code} after {ms, duration}',
  noticeFailed: 'Background task {id} ({tool}) failed after {ms, duration}',
});

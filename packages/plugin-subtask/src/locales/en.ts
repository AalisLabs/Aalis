import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Subtasks',
  groupLabel: 'Subtask management',
  groupSummary: 'Create, manage and coordinate subtask sessions, with parallel execution',
  enabledLabel: 'Enable subtask tools',
  maxWaitMsLabel: 'Max wait per call (ms)',
  modelLabel: 'Subtask model',
  modelDescription:
    'The model a subtask’s session uses, taken from the session that dispatches it and settable per group; the model argument of create_subtask overrides it',
  modelUnset: 'Not set (same as this session)',
  idleLabel: 'Delete after idle once returned (hours)',
  idleDescription:
    'Once a turn of the subtask session ends (with a reply, an error or a stop) and no follow-up arrives for this long, the session is deleted along with its conversation; each follow-up restarts the clock. 0 deletes it as soon as the result is returned. It is not deleted while it has background tasks running',
});

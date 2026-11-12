import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Tool registry',
  backgroundLabel: 'Background tasks',
  maxWaitSecondsLabel: 'Longest foreground wait (seconds)',
  maxWaitSecondsDescription:
    'How many seconds at most a tool call that can move to the background waits in the foreground; a waitSeconds from the model above this counts as this. If it has not finished by then, it moves to the background',
  maxPerSessionLabel: 'Concurrent limit per session',
  maxPerSessionDescription:
    'How many tool calls that can move to the background may run at once in one session, foreground and background counted together; once full, new calls are refused.',
  restarted: 'Still running when Aalis restarted',
  closed: 'Still running when Aalis stopped or the tool registry was disabled',
  withdrawn: 'Tool {name} was unregistered',
  noticeCompleted: 'Background task {id} ({tool}) completed in {ms, duration}',
  noticeFailedExit: 'Background task {id} ({tool}) failed with exit code {code} after {ms, duration}',
  noticeFailed: 'Background task {id} ({tool}) failed after {ms, duration}',
  groupsLabel: 'Tool groups',
  groupsDescription:
    'The tool groups this session can use; * means all. Tools that belong to no group are always given',
  groupsUnset: 'Sessions created on this machine (WebUI, terminal): all groups; other sessions: none',
  groupsAll: 'all groups',
  groupsNone: 'none',
  nobodyCan: "Nobody among this turn's participants can do this",
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Chat approval',
  request: 'Needs your approval: {tool}',
  source: 'From: {kind, select, group {group} private {private chat} other {session}} {id}{name}',
  sourceName: ' ({name})',
  subtask: 'Subtask: {chain}',
  chainStep: '{head} › {tail}',
  factCommand: 'Command: {value}',
  factCwd: 'Directory: {value}',
  factFile: 'File: {value}',
  factPatch: 'Changes: {value}',
  factParams: 'Parameters: {value}',
  clipped: '{head}…({count, plural, one {# character} other {# characters}} omitted)…{tail}',
  howToAnswer:
    'Quote this message and reply “approve”, or “deny” followed by a reason. It expires if there is no answer within {minutes, plural, one {# minute} other {# minutes}}.',
  windowRequest: 'Needs approval: {tool}',
  windowWhy: 'Someone in this turn cannot do this themselves.',
  windowHowToAnswer:
    'Anyone who can do this themselves may quote this message and reply “approve”, or “deny” followed by a reason. It expires if there is no answer within {minutes, plural, one {# minute} other {# minutes}}.',
  answerElsewhere: 'This approval cannot be answered here; handle it in the WebUI or the terminal.',
  alreadySettled: 'This approval has already been handled.',
  answerRefused: 'The answer did not take effect: {reason}',
  expired: 'The approval for {tool} has expired.',
  cancelled: 'The approval for {tool} has been cancelled.',
});

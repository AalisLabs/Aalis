import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'OneBot tools',
  groupManagementLabel: 'Group management tools',
  groupManagementEnabledLabel: 'Enable group management tools',
  groupManagementEnabledDescription: 'Mute, kick, set group cards, recall messages and more',
  groupInfoLabel: 'Group info',
  groupInfoEnabledLabel: 'Enable group info queries',
  groupInfoEnabledDescription: 'Look up group and member info',
  accountLabel: 'Account and friends',
  accountEnabledLabel: 'Enable account and friend queries',
  accountEnabledDescription: 'Group list, friend list and more',
  interactionLabel: 'Special interactions',
  interactionEnabledLabel: 'Enable special interactions',
  interactionEnabledDescription: 'Poke, group check-in and more',
  sessionHistoryLabel: 'Session history',
  sessionHistoryEnabledLabel: 'Enable the OneBot history tools',
  sessionHistoryEnabledDescription:
    'Registers onebot_resolve_session_id / onebot_get_session_history (read recent history by group number or QQ number). Which sessions can be read follows the cross-session rules of session management.',
  maxLimitLabel: 'Maximum messages per read',
  maxLimitDescription: 'The limit parameter passed by the agent is capped at this value.',
  defaultLimitLabel: 'Default messages per read (when the agent passes no limit)',
  defaultLimitDescription: 'Cannot exceed maxLimit.',
  dailyGroup: 'OneBot read-only and everyday',
  dailyGroupSummary:
    'Read-only queries (group info, members, friend list, history, login info) plus low-risk everyday interactions (poke, friend likes)',
  groupGroup: 'OneBot group administration',
  groupGroupSummary:
    'Group administration: mute, mute all, kick, recall messages, set group cards, rename the group, set admins, group check-in, review join requests and more',
  personalGroup: 'OneBot personal / private chat',
  personalGroupSummary:
    'Relationships of the bot account itself: leave groups, delete friends, handle friend requests, accept or decline group invitations',
});

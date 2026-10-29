import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Session management',
  takeScopeLabel: 'Scope for taking from other sessions',
  takeScopeDescription:
    'Which sessions original text can be taken from (tools that read session history, fetching a message by id, cross-session history): this session takes only from this session and the subtasks it dispatched; same platform compares the platforms of both sides (WebUI and the terminal each count as one platform); all compares nothing. An invalid value counts as this session',
  takeScopeSession: 'This session',
  takeScopePlatform: 'Same platform',
  takeScopeAll: 'All',
  takeOtherGroupsLabel: 'Read other groups',
  takeOtherGroupsDescription:
    'Whether content in other group chats can be taken within the scope. An invalid value counts as no',
  takeOthersPrivateLabel: "Read others' private chats",
  takeOthersPrivateDescription:
    "Whether other people's private chats with the assistant can be taken within the scope, the owner's sessions in WebUI and the terminal included; the person calling the tool does not need this to take their own private chat with the assistant. An invalid value counts as no",
  takeCrossBotLabel: 'Across bot accounts',
  takeCrossBotDescription:
    "Whether sessions under the assistant's other bot accounts on the same platform can be taken within the scope. An invalid value counts as no",
  childrenDeleted: '{count, plural, one {Deleted # subsession} other {Deleted # subsessions}}',
  scopeSession: 'Taking from other sessions is limited to this session',
  scopePlatform: 'Taking from other sessions is limited to the same platform',
  crossBot: '"Across bot accounts" is off, so sessions under the assistant\'s other bot accounts cannot be taken from',
  otherGroups: '"Read other groups" is off, so other group chats cannot be taken from',
  othersPrivate: '"Read others\' private chats" is off, so other people\'s private chats cannot be taken from',
  deleteFailed: '{count, plural, one {# error} other {# errors}} while deleting sessions',
});

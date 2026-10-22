import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  childrenDeleted: '{count, plural, one {Deleted # subsession} other {Deleted # subsessions}}',
  scopeSession: 'Taking from other sessions is limited to this session',
  scopePlatform: 'Taking from other sessions is limited to the same platform',
  crossBot: '"Across bot accounts" is off, so sessions under her other bot accounts cannot be taken from',
  otherGroups: '"Read other groups" is off, so other group chats cannot be taken from',
  othersPrivate: '"Read others\' private chats" is off, so other people\'s private chats cannot be taken from',
});

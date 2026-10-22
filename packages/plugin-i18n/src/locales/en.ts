import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Languages',
  pageTitle: 'Translation',
  dictionariesDescription:
    'How the source dictionaries of each package stand in every language. Translated includes what language packs fill in; stale entries are pack entries whose source wording has changed, conflicts are entries with differing translations, and broken entries are translations that fail to parse or whose parameters do not match the source. Select a row to see the keys and the skeletons to translate.',
  dictionary: 'Dictionary',
  language: 'Language',
  translated: 'Translated',
  missing: 'Missing',
  stale: 'Stale',
  conflicts: 'Conflicts',
  broken: 'Broken',
  issues: 'Issues',
  issueLine: '{kind}: {keys, list}',
  noIssues: 'No issues',
  wholeDictionary: 'the whole dictionary',
  dictionaryGone: 'Dictionary {ns} is gone',
  localeSkeleton: 'Skeleton to translate: the plugin’s locales file',
  localeSkeletonDescription:
    'Put it in the plugin’s src/locales/, named after the language tag; missing entries are filled with the source text',
  packSkeleton: 'Skeleton to translate: language pack entries',
  packSkeletonDescription:
    'Contribute it to i18n:pack; only keys without a translation in the dictionary are listed, missing and stale entries are filled with the source text, and from is the fingerprint of the source',
  settingLabel: 'Language',
  settingDescription:
    'Languages for text shown to people, in order of preference; when a translation is missing, the next one is used. "Follow system" uses the system language of the machine running the service, not the reader’s',
  followSystem: 'Follow system (currently: {current})',
  badLanguage: '{tag} is not a valid language tag',
  languagesProvided: 'Every language in the language list is provided by a plugin',
  followedUnprovided: 'Follow system is currently {language}, which no plugin provides; {used} is used instead',
  languageUnprovided: '{language} in the language list is not provided by any plugin; {used} is used instead',
  layerFollowedUnprovided:
    'Follow system in {layer} is currently {language}, which no plugin provides; {used} is used instead',
  layerLanguageUnprovided: '{language} in {layer} is not provided by any plugin; {used} is used instead',
  layerPlatform: '{layer} {platform}',
  layerPlatformType: '{layer} {platform} · {type}',
  layerPlace: '{layer} “{place}”',
  installPack:
    'Install a language pack that provides it (search the plugin market or npm for the keyword {keywords, list, or}), or adjust the “Language” list in the session settings for {layer}',
});

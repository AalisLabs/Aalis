import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  unreachable: 'Cannot reach the score service right now, try again later ({reason})',
  badToken:
    'The score service rejected the developer credentials: check the developerToken setting (HTTP {status}: {message})',
  replied: 'The score service replied: {message}',
  noTarget: 'Could not resolve the target',
  unknownSender:
    'Cannot tell who sent the message (no platform user ID); binding only works on platforms that can identify the sender, such as QQ',
  noMemory:
    'No memory backend is running (bindings are stored in it): enable one in the WebUI plugin area (such as SQLite memory), or remove it from disabledPlugins in the configuration file; if it still fails to start, use /doctor to see why',
  byQq: 'Querying the score service with your QQ number (if this fails, run /maimai bind <friend code> first)',
  noTargetHint:
    'No query target found. Provide the friend_code/qq parameter, or bind yourself first with /maimai bind <friend code>.',
  noFriendCode:
    'The player found by QQ number has no friend code: query with the friend code directly, or bind it first with /maimai bind <friend code>',
  queryFailed: 'Query failed: {error}',
  hint: '({hint})',
  playerName: '{name}  (DX Rating: {rating})',
  playerCode: 'Friend code: {code}',
  playerTrophy: 'Title: {name}',
  playerTrophyColor: 'Title: {name} [{color}]',
  playerStar: 'Awakening: {star}',
  playerSynced: 'Synced: {time}',
  apBests: '[AP B50]',
  bestsTotal: 'B50 total: {total}  (B35 old versions {standard} + B15 current version {dx})',
  bestsStandard: '— Old versions B35 —',
  bestsDx: '— Current version B15 —',
  noRecents: '(No recent plays)',
  recentsHead: 'Last {count, plural, one {# play} other {# plays}}:',
  noKeyword: 'Provide a search keyword',
  noSong: 'No songs match “{keyword}”',
  songsHead: '{count, plural, one {# match} other {# matches}} (keyword: {keyword})',
  songTitle: '#{id} “{title}”  by {artist}',
  songInfo: '  Genre: {genre} | BPM: {bpm} | Version: {version}',
  songAliases: '  Aliases: {aliases}',
  songAliasesMore: '  Aliases: {aliases} ...(+{more})',
  badFriendCode: 'Provide a valid friend code (digits)',
  bindFailed: 'Binding failed: {reason}',
  bound: 'Bound {key} to friend code {code}',
  unbindFailed: 'Unbinding failed: {reason}',
  unbound: 'Your maimai DX friend code has been unbound',
});

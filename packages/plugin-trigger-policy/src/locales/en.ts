import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Trigger policy',
  triggerLabel: 'Rules (count/score)',
  intervalModeLabel: 'Interval mode',
  intervalFixed: 'fixed (count only)',
  intervalDynamic: 'dynamic (score threshold only)',
  intervalBoth: 'both (either one)',
  triggerOnAtLabel: 'Detect @ mentions',
  triggerOnAtDescription:
    'An @ to the assistant counts as a mention (as do pokes and its name): a mention gets a reply right away, the turn is recorded as immediate, and whoever mentioned is the authorizing principal.',
  triggerOnPokeLabel: 'Pokes trigger directly',
  triggerOnPokeDescription:
    'Pokes and similar attention actions trigger right away like an @; when off, such actions fall back to the normal willingness assessment and do not force a reply.',
  triggerNamesLabel: 'Trigger name aliases (comma- or newline-separated)',
  muteKeywordsLabel: 'Mute keywords (comma- or newline-separated)',
  muteTimeSecondsLabel: 'Mute duration on keyword match (seconds)',
  fixedIntervalLabel: 'Fixed interval (trigger every N messages)',
  activityScoreLowerLabel: 'Activity index lower bound',
  activityScoreUpperLabel: 'Activity index upper bound',
  activityDecayMinutesLabel: 'Threshold decay minutes',
  scoreDecayMinutesLabel: 'Score decay minutes (0 = no decay)',
  idleTriggerScopeLabel: 'Idle trigger scope',
  idleScopeOff: 'off (disabled)',
  idleScopeSession: 'session (a timer per session)',
  idleScopePlatform: 'platform (elected across sessions)',
  idleTriggerStrategyLabel: 'Idle trigger strategy',
  idleStrategyAllQuiet: 'all-quiet (when every session is quiet)',
  idleStrategyFixed: 'fixed (fixed interval)',
  idleTriggerMinutesLabel: 'Idle trigger minutes',
  idleTriggerStyleLabel: 'Idle trigger style',
  idleStyleExponential: 'exponential (exponential backoff)',
  idleStyleFixed: 'fixed',
  idleTriggerMaxMinutesLabel: 'Idle trigger maximum minutes',
  idleTriggerJitterLabel: 'Idle trigger jitter',
  idleTriggerPromptLabel: 'Idle trigger system prompt',
});

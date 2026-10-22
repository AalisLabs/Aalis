import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  categoryInterests: 'Interests',
  categoryOccupation: 'Occupation',
  categoryRelationships: 'Relationships',
  categorySituation: 'Current situation',
  categoryValues: 'Values',
  categoryPersonality: 'Personality',
  categoryPreferences: 'Preferences',
  categoryTaboos: 'Taboos',
  categoryOther: 'Other',
  profileHead: '📇 Your profile ({key})',
  profileMeta: 'Relationship strength: {score}/100, interactions: {count}',
  section: '## {name}',
  factLine: '- {text} ({meta})',
  factTimeHint: 'time hint: {hint}',
  factObserved: 'recorded {at, date, short}',
  factTemporary: 'temporary',
  clearType: 'User profiles (across sessions)',
  clearSkipped:
    'User profiles are cross-session data and are cleared only when clearing all sessions, so they were not cleared this time',
});

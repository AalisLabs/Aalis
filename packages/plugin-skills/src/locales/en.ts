import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  enabledLabel: 'Enabled skills',
  enabledDescription:
    'Which skills this session can use: * means all skills, an empty list enables none. Listing, loading, the skill library hint and trigger-based activation only see the enabled ones',
  allSkills: 'All skills',
});

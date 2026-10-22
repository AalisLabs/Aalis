import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  scopeLabel: 'Cross-session history scope',
  scopeDescription:
    'Which sessions passive injection and recent_messages draw recent messages from; it caps both, so a wider scope requested by the tool falls back to it. An invalid value counts as this session only',
  scopeSession: 'This session only (no other sessions)',
  scopeSamePlatform: 'Sessions on the same platform',
  scopeCrossPlatform: 'Sessions on all platforms',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Persona system',
  personasDirLabel: 'Persona directory',
  personasDirDescription:
    "Storage URI of the directory holding the persona files (personas:/ by default, which is self/personas in the home directory; without ':/' the first segment is taken as the storage root name, and a single bare name goes to the data root)",
  statePersistenceLabel: 'State persistence',
  statePersistenceDescription:
    'When on, the persona state (mood, current activity and other outputFormat fields) carries over within the same session and is injected into the next prompt',
  timeInjectionLabel: 'Time injection',
  timeInjectionDescription: 'When on, the current time is injected into the system prompt automatically',
  timeZoneLabel: 'Time zone (IANA)',
  timeZoneDescription:
    "For example Asia/Shanghai, Europe/London, America/New_York. Empty uses the system's local time zone.",
  personaLabel: 'Persona',
  personaDescription:
    'Persona card name (without the extension); default is the default card in the persona directory, or the built-in default persona when there is none',
  extraLabel: 'Extra prompt',
  extraDescription:
    'Appended after the persona prompt and before the structured output instructions; nothing is appended when empty',
  plainLabel: 'No structured output',
  plainDescription: 'Ignore the card’s structured output format and reply in plain text',
  renderLabel: 'Client-side JSON rendering',
  renderDescription: 'Hand the structured output JSON to the client as is, without extracting the reply field',
  renderCard: 'Per card',
  renderOn: 'On',
  renderOff: 'Off',
  clearType: 'Session persona state',
  clearedAll: 'Cleared the persona state of all sessions',
  clearedSession: 'Cleared the persona state of this session',
  clearFailed: 'Clearing persona state failed: {error}',
});

import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
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
});

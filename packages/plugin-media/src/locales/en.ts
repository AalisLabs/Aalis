import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  visionReady: 'Image recognition is available; recognition model: {model}',
  clearTypeImage: 'Image cache',
  clearTypeVideo: 'Video cache',
  uploadsCleared: 'Uploaded images cleared ({count, plural, one {# file} other {# files}})',
  uploadsFailed: 'Failed to clear uploaded images: {error}',
  kindImage: 'image',
  kindVideo: 'video',
  descriptionsClearedAll: 'All {kind} description caches cleared ({count, plural, one {# entry} other {# entries}})',
  descriptionsClearedSession:
    "This session's {kind} description cache cleared ({count, plural, one {# entry} other {# entries}})",
  descriptionsFailed: 'Failed to clear the {kind} description cache: {error}',
});

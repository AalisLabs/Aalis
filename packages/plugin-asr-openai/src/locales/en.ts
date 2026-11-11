import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  modelLabel: 'Model',
  timeoutMsLabel: 'Request timeout (ms)',
  timeoutMsDescription:
    'Maximum time for uploading and recognizing a whole clip; the request is aborted when it runs out. 10 minutes by default.',
  baseUrlInvalid: 'baseUrl must be a full URL without a user name or password',
  baseUrlQuery:
    'baseUrl cannot contain a query string or fragment (anything after ? or #): the plugin appends paths to it',
});

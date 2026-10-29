import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  modelLabel: 'Model',
  timeoutMsLabel: 'Request timeout (ms)',
  timeoutMsDescription:
    'Limit for uploading and recognizing a whole clip. Generous by default (10 minutes): the point is to cut off requests that are truly stuck, not to throttle long audio',
  baseUrlInvalid: 'baseUrl must be a full URL without a user name or password',
  baseUrlQuery:
    'baseUrl cannot contain a query string or fragment (anything after ? or #): the plugin appends paths to it',
});

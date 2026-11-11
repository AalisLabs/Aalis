import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'OKX trading',
  groupSummaryDemo:
    'OKX crypto trading tools (demo trading): market data, account management, order placement and more',
  groupSummaryLive:
    'OKX crypto trading tools (live trading): market data, account management, order placement and more',
  apiKeyDescription: 'The API Key created in the OKX settings',
  passphraseDescription: 'The passphrase set when creating the API key',
  baseUrlLabel: 'API address',
  baseUrlDescription: 'Live trading address by default; can be changed to a custom domain',
  demoLabel: 'Demo trading',
  demoDescription:
    'When on, the simulated trading environment is used; testing in demo trading first is strongly recommended',
  confirmRealMoneyLabel: 'Confirm live trading risk',
  confirmRealMoneyDescription:
    'Must be on to confirm the risk when demo trading is off and real money is used; otherwise only queries remain, without trading tools such as orders, strategies and transfers.',
  timeoutMsLabel: 'Request timeout (ms)',
  enableTradingLabel: 'Enable trading tools',
  enableTradingDescription: 'When off, only query tools remain and placing or cancelling orders is not exposed',
  enableAlgoLabel: 'Enable algo orders',
  enableAlgoDescription: 'Enable take-profit / stop-loss and trigger order tools',
  enableTransferLabel: 'Enable fund transfers',
  enableTransferDescription: 'Enable the funding account transfer tool',
  defaultPageLimitLabel: 'Default page size',
  defaultPageLimitDescription:
    'Used by endpoints that query orders, bills, fills and the like when the model passes no limit.',
  maxPageLimitLabel: 'Max page size',
  maxPageLimitDescription:
    'Most entries a paged query returns at once; larger requests from the model are capped to it. Raising it makes each tool result larger.',
  baseUrlNotPlain: 'baseUrl must be a complete URL without a user name or password',
  baseUrlHasQuery:
    'baseUrl must not contain a query string or fragment (anything after ? or #): the plugin appends paths to it',
  abortedAfterSent:
    'The request was aborted after it had been sent, so whether OKX carried it out is unknown: check the order, position or funding status first, then decide whether to retry',
  outcomeUnknown:
    'The request got no definite result from OKX ({error}), so whether OKX carried it out is unknown: check the order, position or funding status first, then decide whether to retry',
});

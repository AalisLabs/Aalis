import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Usage statistics',
  pricesLabel: 'Prices',
  pricesDescription:
    'Price per million tokens: the key is the model id and the value gives the input, cache-hit and output prices in that order, separated by commas, e.g. 2, 0.5, 8 for deepseek-chat. The cost column only appears once prices are set; models without a price are not counted in the cost',
  currencyLabel: 'Currency',
  currencyDescription: 'The currency shown on the cost column; display only',
  badPrice:
    'The price of “{model}” must be three prices (input, cache hit, output) separated by commas; it takes effect once corrected in WebUI or the config file',
  ledgerUnreadable:
    'The usage ledger {file} cannot be read: check its read and write permissions; to start from an empty ledger, move it away and reload this plugin ← {error}',
  instanceLabel: '{name} ({instance})',
  empty: 'No model calls recorded yet',
  description: 'Costs are estimated from the prices in the config; models without a price are not counted',
  input: 'Input',
  cached: 'Cache hits',
  output: 'Output',
  cost: 'Cost ({currency})',
  byDay: 'By day',
  day: 'Date',
  byWeek: 'By week',
  week: 'Week',
  byModel: 'By model',
  model: 'Model',
  provider: 'Provider',
  balance: 'Balance',
  balanceLabel: '{label} ({currency})',
  balanceFailed: 'Unavailable: {error}',
});

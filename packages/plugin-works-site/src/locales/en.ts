import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  withdrawn: 'Withdrawn',
  withdrawnDegraded: 'Withdrawal registered; site status: {state}',
  productionBranch: 'The production branch does not match the configuration',
  failOpenMismatch: 'fail_open of {name} does not match the configuration',
  binding: '{name} has a {key} binding',
  unknownSetting: '{name} has an unknown setting {key}',
  domains: 'The domain list does not match the configuration',
  unknownDeployment: 'Found an untracked deployment {id}',
  groupMissing: 'The group mapping of a withdrawn work is missing',
  nonceAmbiguous: 'Several deployments share one nonce',
  aliasInvalid: 'The deployment alias is invalid',
  aliasMismatch: 'The deployment alias does not match the branch name',
  cleanupFailed: 'Cleaning up old deployments failed',
  verifyFailed: 'The online check after deployment failed',
  tokenExpired: 'The Cloudflare token has expired',
  authFailed: 'Cloudflare authentication failed',
  periodicCheckFailed: 'The scheduled check failed',
  deployFailedRepeatedly: 'Deployment failed repeatedly',
});

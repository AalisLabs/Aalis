import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  lacking: 'missing service {service} ({trace})',
  failed: '{path} failed: {reason}',
  reasonInLog: 'see the logs for the reason',
  disabled: '{path} is disabled',
  starting: 'waiting for {instance} to start',
  lingering: 'waiting for the old instance of {instance} to stop',
  withdrawn: '{path} is running but does not provide {service}',
  unprovided: 'no installed plugin provides it',
  unprovidedVia: '{path} → no installed plugin provides {service}',
  cycle: 'waiting on each other in a cycle: {instances, list}',
  cycleVia: '{path} → waiting on each other in a cycle: {instances, list}',
  retryExhausted:
    'A required dependency kept going missing during initialization (last missing: {service}); automatic retries did not settle and stopped. Re-enable or reload it to retry',
  providesNotRegistered:
    'Declares that it provides {services, list}, but had not registered them when activation finished',
  exclusiveConflict: 'Service {service} is registered exclusively; no other provider can be added',
  unavailable: 'Service {service} has no provider right now',
  unavailableFrom: 'Provider {provider} of service {service} is not available right now',
});

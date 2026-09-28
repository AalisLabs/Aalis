import { configSchema, normalizeConfig } from '../../packages/plugin-trigger-policy/src/config.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';

export const resolveTriggerPolicyConfig = (raw: unknown) => normalizeConfig(parseConfig(configSchema, raw));
export const defaultTriggerPolicyConfig = resolveTriggerPolicyConfig({});

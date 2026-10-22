import { resolveFields } from '../../packages/api-session-settings/src/index.js';
import { configSchema, normalizeSettings } from '../../packages/plugin-trigger-policy/src/config.js';

/** 只有全局层（插件配置）时一个会话的参数：与插件按会话读的同一解析 */
export const resolveTriggerPolicySettings = (raw: Record<string, unknown>) =>
  normalizeSettings(resolveFields(configSchema, raw, { parts: [] }, () => {}).values as never);
export const defaultTriggerPolicySettings = resolveTriggerPolicySettings({});

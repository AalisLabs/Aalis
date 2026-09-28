import { type ConfigOf, defineConfig } from '@aalis/schema-config';

// ----- 流控配置 -----

export const configSchema = defineConfig({
  // 空数组 = 冷却与限速对任何会话都不生效；overrides 里任一 scope 命中的会话照样视为启用
  scopes: {
    type: 'multiselect',
    label: '生效作用域',
    default: ['*:group'],
    dynamicOptions: 'gateway-scopes',
    allowCustom: true,
    description:
      '冷却与限速只对作用域内会话生效：入站过闸与回复记账都看它（委派闸门、闲置选会话读的是这份记账）；禁言不看作用域。格式 platform:sessionType，支持通配 *；onebot:group / onebot:* / *:group / *。默认 *:group；默认作用域不含 WebUI/CLI，如需纳入，在这里显式添加。',
  },
  cooldownSeconds: { type: 'number', label: '回复后冷却（秒）', default: 10 },
  rateLimitWindow: { type: 'number', label: '限速窗口（秒，0=关闭）', default: 0 },
  rateLimitMaxReplies: { type: 'number', label: '窗口内最大回复数', default: 10 },
  // 元素里的数值字段不设 default：没填的键不进解析结果，resolveEffectiveConfig 才会让它沿用顶层配置
  overrides: {
    type: 'array',
    label: '分作用域覆盖',
    description:
      '每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段；字段留空（或不填）= 沿用上方默认，不会被覆盖为 0/空。最具体匹配优先（targetId > sessionType > platform > 通配）。例：scope="*:private", cooldownSeconds=10 让所有平台私聊单独 10s 冷却，其他字段继续走默认。从未有真人消息经过本相位的会话，入站带 source 的内部注入（定时任务等）与回复记账都按会话 ID 约定（platform:self:type:target）推断类型与目标；不符合约定的（如 WebUI）没有会话类型与目标，按类型或目标写的覆盖对其不生效，走上方默认。',
    default: [],
    items: {
      scope: {
        type: 'string',
        label: '作用域',
        description: '格式 platform:sessionType[:targetId]，支持 *',
        required: true,
      },
      cooldownSeconds: { type: 'number', label: '回复后冷却（秒）' },
      rateLimitWindow: { type: 'number', label: '限速窗口（秒）' },
      rateLimitMaxReplies: { type: 'number', label: '窗口内最大回复数' },
    },
  },
});

export type FlowControlConfig = ConfigOf<typeof configSchema>;

/**
 * parseConfig 之后的作用域核对。作用域串由 api-gateway 按冒号切段，空段按通配算、段内空白不去：
 * scopes 里的空串或纯空白可能形成宽泛匹配，所以丢弃；
 * override 的 scope 去掉首尾空白，只剩空白的那一项丢弃（缺 scope 或 scope 为空串的项 parseConfig 已丢弃）。
 */
export function normalizeScopes(cfg: FlowControlConfig, logger: { warn(message: string): void }): FlowControlConfig {
  const scopes = cfg.scopes.filter(s => s.trim() !== '');
  if (scopes.length < cfg.scopes.length) logger.warn('配置项 scopes 含空白作用域（可能匹配所有会话），已忽略');
  const overrides: FlowControlConfig['overrides'] = [];
  for (const o of cfg.overrides) {
    const scope = o.scope.trim();
    if (scope) overrides.push({ ...o, scope });
    else logger.warn('配置项 overrides 中有一项 scope 只含空白，已忽略该项');
  }
  return { ...cfg, scopes, overrides };
}

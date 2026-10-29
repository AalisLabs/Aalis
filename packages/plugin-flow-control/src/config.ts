import { REPLY_AUDIENCE_FIELD } from '@aalis/api-gateway';
import type {} from '@aalis/api-session-settings'; // 按会话字段的声明成员经 declaration merging 并入 SessionFieldSpec
import { defineConfig, type SessionFieldsOf } from '@aalis/schema-config';
import { t } from './texts.js';

// ----- 流控配置 -----

/** 可按会话设的参数：只适用于房间，收在高级里 */
const ROOM = { appliesTo: ['room'], prominence: 'advanced' } as const;

// 冷却与限速只对生效范围内的房间生效：入站过闸与回复记账都看它（委派闸门、闲置选会话读的是这份记账）；禁言不看生效范围。
// 生效范围与三个参数都可按会话设（平台档、平台类型档、场所、本会话），每次按会话现读
export const configSchema = defineConfig({
  audience: { ...REPLY_AUDIENCE_FIELD, session: { appliesTo: ['room'], prominence: 'common' } },
  cooldownSeconds: { type: 'number', label: t('cooldownSecondsLabel'), default: 10, session: ROOM },
  rateLimitWindow: { type: 'number', label: t('rateLimitWindowLabel'), default: 0, session: ROOM },
  rateLimitMaxReplies: { type: 'number', label: t('rateLimitMaxRepliesLabel'), default: 10, session: ROOM },
});

/** 一个会话此刻的流控参数 */
export type FlowControlSettings = SessionFieldsOf<typeof configSchema>;

import { authority } from '@aalis/api-authority';
import { commands } from '@aalis/api-commands';
import { hostConfig } from '@aalis/api-host-config';
import { platform } from '@aalis/api-platform';
import { sessionManager } from '@aalis/api-session-manager';
import { type BoundOf, events, logger, optional, provide, services } from '@aalis/core';

// 会话设置插件用到的能力。值在会话管理的记录上，会话管理缺席时停在 pending。宿主配置文档缺席时平台档、平台类型档为空，
// 写这两层与全局层被拒；services 写声明了 preference 的字段的本插件偏好。平台列可设的平台与类型；权限服务给指令判门槛，缺席时
// 指令一律拒绝写；指令服务缺席时 /session 系列不在
export const uses = {
  sessionManager,
  events,
  logger,
  provide,
  services,
  hostConfig: optional(hostConfig),
  platform: optional(platform),
  authority: optional(authority),
  commands: optional(commands),
};
export type Caps = BoundOf<typeof uses>;

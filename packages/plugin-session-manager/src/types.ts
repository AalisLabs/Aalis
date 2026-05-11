// 类型 + 能力声明已迁移到 @aalis/plugin-session-manager-api。
// 此处仅为向后兼容 re-export；新代码请直接 import from '@aalis/plugin-session-manager-api'。
export type {
  PlatformProfile,
  SessionConfig,
  SessionInfo,
  SessionManagerCapability,
  SessionManagerCapabilityRegistry,
  SessionManagerService,
  SessionTreeNode,
} from '@aalis/plugin-session-manager-api';
export { SessionManagerCapabilities } from '@aalis/plugin-session-manager-api';

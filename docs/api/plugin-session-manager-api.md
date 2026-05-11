# plugin-session-manager-api — 会话配置与树形管理契约

**包名**: `@aalis/plugin-session-manager-api`  
**源码**: `packages/plugin-session-manager-api/src/index.ts`  
**实现**: `@aalis/plugin-session-manager`

## 概述

定义每个会话独立的配置覆盖（LLM/模型/工具集/人格）、平台配置模板、会话树形层级。Agent 处理消息时通过本服务的 `resolveConfig()` 合并出最终生效配置。

## 关键类型

```ts
interface SessionConfig {
  llmProvider?: string;        // 指定 LLM 实例 contextId
  model?: string;              // 模型 ID，如 'deepseek-chat'
  enabledToolGroups?: string[];
  persona?: string;            // 人格文件名（不含 .yaml）
  systemPromptExtra?: string;
  maxToolIterations?: number;
  disableOutputFormat?: boolean;
  clientSideJsonRendering?: boolean;
  sessionDefaults?: Omit<SessionConfig, 'sessionDefaults'>; // 子会话默认
}

type PlatformProfile = SessionConfig;   // 平台默认模板（在 webui 配置）

interface SessionInfo {
  id: string;
  name: string;
  title?: string;
  parentId?: string;
  children: string[];
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  config: SessionConfig;
  createdAt: number;
  updatedAt: number;
  createdBy?: 'user' | 'agent' | 'scheduler' | 'system';
  inputContext?: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}
```

## 配置解析优先级

从高到低：

1. 会话自身 `config`（手工 / `/model` 指令设置）
2. 父会话 `sessionDefaults`（递归继承）
3. 平台默认 `platformProfiles[platform]`
4. 全局 `defaultConfig`（各插件 schema）

## 服务接口（节选）

```ts
interface SessionManagerService {
  ensureSession(sessionId: string, platform: string): Promise<SessionInfo>;
  getSession(sessionId: string): SessionInfo | undefined;
  list(filter?: { parentId?: string; status?: string }): SessionInfo[];
  createChild(parentId: string, input: { name?; inputContext? }): Promise<SessionInfo>;
  updateConfig(sessionId: string, patch: Partial<SessionConfig>): Promise<void>;
  resolveConfig(sessionId: string, platform: string): Promise<SessionConfig>;
  getTree(rootId?: string): SessionTreeNode[];
  setStatus(sessionId: string, status: SessionInfo['status']): Promise<void>;
}
```

> 完整签名以源码 `index.ts` 为准；上面是消费方最常用的部分。

## 实现者

- [@aalis/plugin-session-manager](../plugins/plugin-session-manager.md) — 元数据持久化到 `MemoryService` 的 `session` namespace

## 相关

- `/model`、`/persona` 等指令在 [plugin-commands](../plugins/plugin-commands.md) 中由 session-manager 注册
- 子会话编排见 `@aalis/plugin-session-channel`

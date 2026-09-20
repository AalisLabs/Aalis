# api-session-manager — 会话配置与树形管理契约

**包名**: `@aalis/api-session-manager`  
**源码**: `packages/api-session-manager/src/index.ts`  
**实现**: `@aalis/plugin-session-manager`

## 概述

定义每个会话独立的配置覆盖（LLM/模型/工具集/人格）、平台配置模板、会话树形层级。Agent 处理消息时通过本服务的 `resolveConfig()` 合并出最终生效配置。

## 关键类型

```ts
interface SessionConfig {
  llm?: { provider: string; model: string };  // LLM 模型引用（ConfigSchema 中以 type:'llm-ref' 字段编辑）
  enabledToolGroups?: string[]; // 启用的工具分组；'*' = 全部分组。会话未设置时继承平台档，最终为空则只给无分组的通用工具
  persona?: string;            // 人格文件名（不含 .yaml）
  think?: boolean;             // 会话级 thinking 覆盖（/session.set -t；未设置=继承 provider 全局）
  systemPromptExtra?: string;
  maxToolIterations?: number;   // 覆盖 agent 全局值（正整数；非正整数视为未设置）
  disableOutputFormat?: boolean;
  clientSideJsonRendering?: boolean;
  sessionDefaults?: Omit<SessionConfig, 'sessionDefaults'>; // 子会话默认
}

type PlatformProfile = SessionConfig;   // 平台默认模板（写在插件配置 platformProfiles，无运行时写接口）

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
4. 全局默认值（各插件 configSchema 派生）

## 服务接口（节选）

描述符 `sessionManager`（`name: 'session-manager'`），绑定接口是普通 `ServiceRef<SessionManagerService>`。

```ts
interface SessionManagerService {
  createSession(opts?): Promise<SessionInfo>;
  getSession(id: string): SessionInfo | undefined;
  listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
  updateSession(id, updates): Promise<SessionInfo>;
  ensureSession(id, patch?): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
  createChildSession(parentId, opts?): Promise<SessionInfo>;
  getChildren(parentId: string): SessionInfo[];
  getTree(rootId?: string): SessionTreeNode[];
  completeSession(id: string, result?: string): Promise<void>;
  resolveConfig(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'>;
  resolveInheritedDefaults(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'>;
  getPlatformProfiles(): Record<string, PlatformProfile>;
  getDefaults(): Omit<SessionConfig, 'sessionDefaults'>;
  generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
}
```

> 完整签名以源码 `index.ts` 为准；上面是消费方最常用的部分。

## 实现者

- [@aalis/plugin-session-manager](../plugins/plugin-session-manager.md) — 元数据持久化到 `MemoryService` 的 `session` namespace

## 相关

- `/model`、`/persona` 等指令由 [plugin-agent](../plugins/plugin-agent.md) 注册（不是 session-manager）

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
  systemPromptExtra?: string;   // 额外系统提示，由 persona 追加在人设提示之后（未装 persona 不生效）
  maxToolIterations?: number;   // 覆盖 agent 全局值（正整数；非正整数视为未设置）
  disableOutputFormat?: boolean;
  clientSideJsonRendering?: boolean;
  paperEnabled?: boolean;              // 本房间开启白纸（默认关）
  paperName?: string;                  // 白纸名；不写则每个房间各一块
  remoteAgentTypes?: string[];         // 允许的远端代理类型（提供者实例 id）；空或缺省 = 关
  remoteAgentUserDailyCents?: number;  // 每人每天金额上限（美分）；缺省不按人限制
  remoteAgentUserDailyTasks?: number;  // 每人每天件数上限；缺省不按人限制
  remoteAgentRoomDailyCents?: number;  // 本房间每天金额上限（美分）；缺省按 0
  memoryRecallScope?: MemoryRecallScope; // 记忆召回范围，只能比记忆插件的配置更窄
  sessionDefaults?: Omit<SessionConfig, 'sessionDefaults'>; // 子会话默认
}

type MemoryRecallScope = 'session' | 'platform' | 'all';

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

## 房间键

白纸与远端代理的六个键（`paperEnabled`、`paperName`、`remoteAgentTypes` 与三项上限）由白纸枢纽 [plugin-paper](../plugins/plugin-paper.md) 读取，含义见该页。它们只经继承链实时解析，不随建会话复制：

```ts
const ROOM_ONLY_CONFIG_KEYS: readonly ['paperEnabled', 'paperName', 'remoteAgentTypes',
  'remoteAgentUserDailyCents', 'remoteAgentUserDailyTasks', 'remoteAgentRoomDailyCents'];
function omitRoomOnlyKeys<T extends SessionConfig>(config: T): Omit<T, (typeof ROOM_ONLY_CONFIG_KEYS)[number]>;
```

建会话时复制生效配置（WebUI 建会话、`create_subtask` 建子会话）会把复制时的值冻结进新会话，此后房间或平台档改了也不跟着变，子会话还会凭冻结的值继续开远端任务。复制一律经 `omitRoomOnlyKeys`，返回去掉这六个键的新对象。

`memoryRecallScope` 不在其中，随子会话复制：子会话不带上更窄的召回范围，经子任务就绕过了收窄。它的取值：`session` 只召回本会话，`platform` 最多同平台，`all` 不限。它只能收窄、不能放宽各插件自己的范围配置，写得比插件配置宽时按插件配置。消费方各自的收窄方式见 [plugin-memory-vector](../plugins/plugin-memory-vector.md)、[plugin-memory-history](../plugins/plugin-memory-history.md)、`session-history` 服务（[plugin-tool-session](../plugins/plugin-tool-session.md)）与 [plugin-user-relation](../plugins/user-relation.md)（只认 `session`）；plugin-user-profile 不读它。

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

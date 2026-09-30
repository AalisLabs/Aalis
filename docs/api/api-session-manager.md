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
  remoteAgentUserDailyCents?: number;  // 每人每天金额上限（美分）；不填不额外限制，0 禁止开新任务
  remoteAgentUserDailyTasks?: number;  // 每人每天件数上限；缺省不按人限制
  remoteAgentRoomDailyCents?: number;  // 本房间每天金额上限（美分）；不填不额外限制，0 禁止开新任务
  memoryRecallScope?: MemoryRecallScope; // 记忆召回范围，只能比记忆插件的配置更窄
  sessionDefaults?: Omit<SessionConfig, 'sessionDefaults'>; // 子会话默认
}

type MemoryRecallScope = 'session' | 'platform' | 'all';

type PlatformProfile = SessionConfig;   // 平台默认模板（写在插件配置 platformProfiles，无运行时写接口）

type SessionKind = 'room' | 'task';                  // room=聊天用的会话；task=挂在发起它的会话下面的子会话
type RoomAudience = 'owner' | 'private' | 'group';   // private、group 为 IM 房间；owner 只表示「不是 IM 房间」

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
  kind: SessionKind;               // 有 parentId 为 task，其余为 room
  originPlatform?: string;         // 出生平台（api-gateway 的 resolveSessionOrigin）；owner 面会话及其子会话没有
  audience?: RoomAudience;         // 只有 room 带：有出生平台的取 group 或 private，其余为 owner
}

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

/** 继承链的层：全局 defaults、平台档、平台档的受众条目、父会话的 sessionDefaults */
type InheritanceSource = 'defaults' | 'platform' | 'audience' | 'parent';

interface SessionInheritance {
  platform?: string;                                   // 选档用的平台：有出生平台的为出生平台，否则为传入的入口平台
  audience?: 'group' | 'private';                      // 选档用的受众：只有房间会话带
  values: Omit<SessionConfig, 'sessionDefaults'>;      // 继承值（不含会话自身 config 与 sessionDefaults）
  sources: Partial<Record<keyof SessionConfig, InheritanceSource>>;  // 每个键来自哪一层
}

type SessionListSection = 'owner' | 'rooms';         // 会话列表的分区：我的会话、IM 房间
function sessionListSection(session: Pick<SessionInfo, 'audience'>): SessionListSection;  // private、group 为 rooms，其余为 owner

interface SessionTreeSection {
  key: SessionListSection;
  label: string;                   // 显示名：「我的会话」「IM 房间」
  nodes: SessionTreeNode[];        // 本区的根会话，子会话挂在各自父节点下
}
```

`kind`、`originPlatform`、`audience` 由 session-manager 只按会话 ID 与 `parentId` 推出，新建、建档与加载时覆盖写入，调用方传的值与存储里的旧值都不采信；`createSession`、`createChildSession` 的参数类型里没有这三个字段。`audience: 'owner'` 只表示「不是 IM 房间」，凡是没有出生平台的根会话都算，包括 `mcp-server`、`workflow::<id>` 与定时任务指定的目标会话，不代表 owner 本人在场，只供列表分区用。非房间会话的 ID 不得含单冒号，否则会被当成房间。

## 配置解析优先级

从高到低：

1. 会话自身 `config`（手工 / `/model` 指令设置）
2. 父会话 `sessionDefaults`（递归继承）
3. 平台默认 `platformProfiles[platform]`，房间会话另叠加受众条目（见下文）
4. 全局默认值（各插件 configSchema 派生）

### 房间会话钉死出生平台

第 3 层按哪个平台选档：会话有出生平台（api-gateway 的 `resolveSessionOrigin`，子任务按父会话算）时按出生平台，忽略调用方传入的 `platform`；没有出生平台的 owner 面会话（WebUI、CLI 等）按传入的入口平台。因此从 WebUI 往 QQ 群插话，这一轮仍按 onebot 的平台档选工具组、人设与模型；入口平台只用来认出说话的人。`resolveConfig` 与 `resolveInheritance` 同一选法。钉死只管继承链，会话自身 `config` 里的覆盖仍优先于平台档。

### 受众条目

平台档可以另写只对群或只对私聊生效的受众条目（插件配置 `platformProfiles` 的条目带 `audience: group` 或 `audience: private`）。受众条目只列与同平台基础档（不写受众的那条）不同的键，叠加在基础档之上，来源层记为 `audience`；只对有出生平台的房间会话生效，owner 面会话不取受众条目。`getPlatformProfiles()` 只回基础档，不含受众条目：要知道某个房间的某个键是否来自平台档，看 `resolveInheritance(id).sources[键]` 是 `platform` 还是 `audience`。

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
  // 继承链（不含会话自身 config）：defaults → 平台档 → 受众条目 → 父会话 sessionDefaults，另回选档平台、受众与每个键的来源
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance;
  getPlatformProfiles(): Record<string, PlatformProfile>;   // 只回基础档，不含受众条目
  getDefaults(): Omit<SessionConfig, 'sessionDefaults'>;
  generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
}
```

> 完整签名以源码 `index.ts` 为准；上面是消费方最常用的部分。

`resolveInheritance` 供 WebUI 的「继承」提示与 `/session` 的来源显示用：只看继承值，才不会把会话自己的覆盖当成继承来的。

`sessionListSection` 是纯函数，参考实现的页面动作 `getSessionTree` 用它把 `getTree()` 的根会话分成「我的会话」「IM 房间」两区，回 `SessionTreeSection[]`（我的会话在前，空区不回）；服务方法 `getTree()` 仍回不分区的 `SessionTreeNode[]`。

## 实现者

- [@aalis/plugin-session-manager](../plugins/plugin-session-manager.md) — 元数据持久化到 `MemoryService` 的 `sessions` namespace

## 相关

- `/model`、`/persona` 等指令由 [plugin-agent](../plugins/plugin-agent.md) 注册（不是 session-manager）

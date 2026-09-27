# 会话管理服务（session-manager）

> 受众：编写或消费「会话生命周期 + 会话级配置解析」的第三方插件作者。
> 先读 [服务模型](../concepts/service-model.md) 与 [惰性服务访问](../concepts/lazy-service-access.md)；本文是它们在「会话」这个具体服务上的落点。配置如何流入 LLM 调用见 [消息-LLM 流水线](../concepts/message-llm-pipeline.md)。

## 1. 定位

session-manager 维护对话会话的生命周期（创建 / 查询 / 状态 / 树形父子关系），并把分层会话配置合并成一份「最终生效配置」交给 Agent 消费。取用名 `sessionManager.current`，契约包 `@aalis/api-session-manager`，参考实现 `@aalis/plugin-session-manager`。

核心职责两件：

- **配置解析**：会话自身 config → 父会话 `sessionDefaults` → 平台 profile → 全局 defaults，按优先级合并出一份 `resolveConfig(sessionId, platform)`（`api-session-manager/src/index.ts`、实现 `plugin-session-manager/src/index.ts`）。平台 profile 的选法：IM 房间按出生平台（与受众）选档，不论从哪个入口驱动；传入的入口平台只对没有出生平台的会话起作用（§2.4）。Agent 每条消息都查它来决定用哪个 LLM / persona / 工具分组。
- **生命周期与会话树**：CRUD + 父子树 + `active/waiting/completed/error/archived` 状态机；会话状态由本插件**自治维护**（回合开始的 `agent:input:before` 中间件翻 `active` 并在回合结束时收口，另有 `outbound:message` / `agent:turn:after` 收口，见 §7.1），并通过 `session:*` 事件广播（`plugin-session-manager/src/index.ts`）。IM 房间由 `inbound:message` 上的收录监听登记（§6.6）。

它**不是**消息存储——历史消息存在 `memory` 服务里；本服务只把会话元数据持久化到 `memory` 的 metadata 命名空间 `sessions`（`plugin-session-manager/src/index.ts`）。

## 2. 契约（`@aalis/api-session-manager/src/index.ts`）

### 2.1 服务接口 `SessionManagerService`（`index.ts`）

```ts
// CRUD（kind、originPlatform、audience 由服务推出，不收调用方传值）
createSession(opts?: Partial<Omit<SessionInfo, 'id'|'children'|'createdAt'|'updatedAt'|'kind'|'originPlatform'|'audience'>>): Promise<SessionInfo>;
getSession(id: string): SessionInfo | undefined;
listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
updateSession(id: string, updates: Partial<Pick<SessionInfo, 'name'|'config'|'status'|'metadata'>>): Promise<SessionInfo>;
// 按精确 id 幂等 upsert：命中 → 合并式 update（发 session:updated）；未命中 → 以传入 id（不自生成）建记录（状态缺省 active，发 session:created）。
// 供平台派生 sessionId（如 onebot:<self>:group:<gid>）首次落配置覆盖时按原样 id 建档——这些 id 不经 createSession 预建。
// IM 房间主要由参考实现的入站收录登记（§6.6），/session.set 与开子任务时经这里补建。
ensureSession(id: string, patch?: Partial<Pick<SessionInfo, 'name'|'config'|'status'|'metadata'|'createdBy'>>): Promise<SessionInfo>;
deleteSession(id: string): Promise<void>;            // 同时清理其消息历史

// 树形
  // 父会话未建档时（平台派生 id 从不经 createSession 预建）先按原样 id 兜底建档，再挂子会话；有出生平台的房间以会话 id 为名
createChildSession(parentId: string, opts?: Partial<Omit<SessionInfo, 'id'|'parentId'|'children'|'createdAt'|'updatedAt'|'kind'|'originPlatform'|'audience'>>): Promise<SessionInfo>;
getChildren(parentId: string): SessionInfo[];
getTree(rootId?: string): SessionTreeNode[];

// 生命周期
completeSession(id: string, result?: string): Promise<void>;   // 触发 session:completed

// 配置解析（同步，非 Promise）；平台档的选法见 §2.4
resolveConfig(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'>;
// 继承链（不含会话自身 config），另回选档平台、受众与每个键的来源层；WebUI「继承」提示与 /session 的来源显示用它
resolveInheritance(sessionId: string, platform?: string): SessionInheritance;
getDefaults(): Omit<SessionConfig, 'sessionDefaults'>;
getPlatformProfiles(): Record<string, PlatformProfile>;   // 只回基础档，不含受众条目

// 标题
generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined>;  // 调 LLM 总结
updateSessionTitle(sessionId: string, title: string): Promise<void>;
```

`resolveConfig` / `resolveInheritance` / `getDefaults` / `getPlatformProfiles` 是**同步**方法（直接读内存 Map），不要 `await`。

### 2.2 重要类型

`SessionConfig`（`index.ts`）——会话级覆盖，全部字段可选：

```ts
interface SessionConfig {
  llm?: { provider: string; model: string };  // provider = LLM 插件实例 contextId（如 @aalis/plugin-llm-openai:main）
  enabledToolGroups?: string[];                // 启用的工具分组；'*' = 全部分组。会话未设置时继承平台档，最终为空则只给无分组的通用工具
  persona?: string;                            // 人格文件名（不含后缀）
  think?: boolean;                             // 会话级 thinking 覆盖（/session.set -t on|off；未设置=继承 provider 全局）
  systemPromptExtra?: string;                  // 额外系统提示，由 persona 追加在人设提示之后（未装 persona 不生效）
  maxToolIterations?: number;                  // 覆盖 agent 全局值（正整数；非正整数视为未设置）
  disableOutputFormat?: boolean;               // 该会话回复纯文本，不走结构化输出
  clientSideJsonRendering?: boolean;           // 保留完整 JSON 给前端渲染
  paperEnabled?: boolean;                      // 白纸与远端代理的房间键（这一行到 remoteAgentRoomDailyCents），见 §6.7
  paperName?: string;
  remoteAgentTypes?: string[];
  remoteAgentUserDailyCents?: number;
  remoteAgentUserDailyTasks?: number;
  remoteAgentRoomDailyCents?: number;
  memoryRecallScope?: 'session' | 'platform' | 'all';  // 记忆召回范围，只能比记忆插件的配置更窄；随子会话复制
  sessionDefaults?: Omit<SessionConfig, 'sessionDefaults'>;  // 子会话继承的默认（解析结果里会被剥掉）
}
```

`PlatformProfile = SessionConfig`（`index.ts`）——每个平台一份模板，同一平台可另写只对群或只对私聊生效的受众条目（§2.4）。**平台档只从插件配置 `platformProfiles` 加载，没有运行时写接口**：改平台档就是改配置（WebUI 配置页 / `aalis.config.yaml`），改完经热重载生效。

`SessionInfo`（`index.ts`）——会话本体：

```ts
interface SessionInfo {
  id: string;
  name: string;
  title?: string;                  // AI 总结或父会话指定
  parentId?: string;               // 根会话为 undefined
  children: string[];
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  config: SessionConfig;
  createdAt: number; updatedAt: number;
  createdBy?: 'user' | 'agent' | 'scheduler' | 'system';
  inputContext?: string;           // 父会话传入的指令 / 上下文（见 §6.3）
  result?: string;                 // 子会话完成后填，供向父会话汇报
  metadata?: Record<string, unknown>;
  kind: 'room' | 'task';           // SessionKind：有 parentId 为 task（挂在发起它的会话下面的子会话），其余为 room
  originPlatform?: string;         // 出生平台（api-gateway 的 resolveSessionOrigin）；owner 面会话及其子会话没有
  audience?: 'owner' | 'private' | 'group';  // RoomAudience，只有 room 带：有出生平台的取 group 或 private，其余为 owner
}
```

`kind`、`originPlatform`、`audience` 只按会话 id 与 `parentId` 推出（参考实现的私有函数 `describeSession`），新建、建档与加载入表时覆盖写入，调用方传的值与存储里的旧值都不采信。`audience: 'owner'` 只表示「不是 IM 房间」：凡是没有出生平台的根会话都落在这里，包括 `mcp-server`、`workflow::<id>` 与定时任务指定的目标会话，并不都是 owner 本人在说话，只供列表分区用，不能拿来判断「owner 在场」。非房间会话的 id 不得含单冒号，否则会被当成房间（会话 id 约定见 [platform 服务](platform.md)）。

`SessionTreeNode = { session: SessionInfo; children: SessionTreeNode[] }`（`index.ts`，递归）。服务方法 `getTree()` 回不分区的根会话列表。会话页用的是分区形状：`SessionTreeSection = { key: 'owner' | 'rooms'; label: string; nodes: SessionTreeNode[] }`，分区由纯函数 `sessionListSection(session)` 判定（`audience` 为 `private`、`group` 的进 `rooms`「IM 房间」，其余进 `owner`「我的会话」），参考实现的页面动作 `getSessionTree` 按「我的会话」「IM 房间」的顺序回，空区不回，子会话只挂在各自父节点下、不作为任何区的根。

`SessionInheritance`（`index.ts`）——`resolveInheritance` 的返回：

```ts
type InheritanceSource = 'defaults' | 'platform' | 'audience' | 'parent';
interface SessionInheritance {
  platform?: string;                               // 选档用的平台：有出生平台的为出生平台，否则为传入的入口平台
  audience?: 'group' | 'private';                  // 选档用的受众：只有房间会话带
  values: Omit<SessionConfig, 'sessionDefaults'>;  // 继承值（不含会话自身 config 与 sessionDefaults）
  sources: Partial<Record<keyof SessionConfig, InheritanceSource>>;  // 每个键最终来自哪一层
}
```

### 2.3 事件 augmentation（`index.ts`）

本 `-api` 包通过 `declare module '@aalis/core'` 增量声明了四个生命周期事件到 `AalisEvents`：

```ts
'session:created':   [session: SessionInfo];
'session:updated':   [session: SessionInfo];
'session:completed': [session: SessionInfo];
'session:deleted':   [sessionId: string];
```

**只想监听这些事件**（而不调用服务）的插件也应当依赖本 `-api` 包——它锚定了 `import type {} from '@aalis/core'` 让 augmentation 生效（`index.ts`）。`plugin-file-reader` 就是仅为 `session:deleted` 事件而 `import type {} from '@aalis/api-session-manager'`（`plugin-file-reader/src/index.ts`）。

### 2.4 平台档的选法：钉死出生平台与受众条目

`resolveConfig` 与 `resolveInheritance` 的平台档层按下面的规则选档（契约写在 `resolveInheritance` 的说明里）：

- 会话有出生平台（api-gateway 的 `resolveSessionOrigin(sessionId)` 有值，子任务按父会话算）：按出生平台选档，忽略传入的 `platform`；适配器没加载时同样如此。IM 房间不论从哪个入口驱动都按自己的平台档运行：owner 从 WebUI 往 QQ 群插话，这一轮的工具组、人设与模型仍取 onebot 的档，入口平台只用来认出说话的人。
- 会话没有出生平台（WebUI 的 `session-<8位>`、CLI 的 `cli-default` 等 owner 面会话）：按调用方传入的入口平台选档。
- 受众条目：插件配置 `platformProfiles` 的条目可以带 `audience`（`group` 为群与频道，`private` 为私聊，不写为该平台全部房间）。带受众的条目只列与同平台基础档不同的键，叠加在基础档之上，来源层记为 `audience`，只对有出生平台的会话生效。受众取值不是 `group`、`private` 的条目整条丢弃并告警，不当成不限受众。`getPlatformProfiles()` 只回基础档（它的返回会被页面动作整份复制进新会话的 config），要知道某个键是否来自平台档，看 `resolveInheritance(id).sources[键]` 是 `platform` 还是 `audience`。

继承链从低到高：全局 defaults → 平台档 → 受众条目 → 父会话 `sessionDefaults`，`resolveConfig` 再叠上会话自身 config。钉死只管继承链：会话自身 config 里的覆盖仍优先于平台档。

参考实现的页面动作 `getInheritance`（WebUI「继承」提示用）对有出生平台的会话直接回 `resolveInheritance(sessionId)`；没有出生平台的会话先按「会话 metadata 记下的平台 → 接管这个 id 的平台适配器 → webui」推出入口平台，再解析。plugin-agent 的 `/session` 同样读 `resolveInheritance`，每个字段显示生效值与来源（会话覆盖、父会话、平台档 `<平台>`、平台档 `<平台>`（私聊或群）、默认）。

## 3. 谁提供 / 谁消费

**提供方（唯一参考实现）**：`@aalis/plugin-session-manager`，在 `apply()` 里 `provide(sessionManager, manager, { label: '会话管理' })`（`plugin-session-manager/src/index.ts`）。它 `uses required = ['memory']`、`optional = ['agent','platform','persona','llm']`（`index.ts`）。没有 `memory` 时直接拒绝启动（`index.ts`）。

**典型消费点**：

| 消费方 | 用法 | file:line |
| --- | --- | --- |
| `plugin-agent` | 每条消息 `resolveConfig()` 决定 LLM / persona / 工具分组；`/session.set`·`/session.reset` 走 `ensureSession()` 落配置（`/model` 仅列/搜可用模型，不写配置） | `plugin-agent/src/index.ts` |
| `plugin-subtask` | `createChildSession(parentId, { inputContext: task, ... })` 派发子任务；`agent:turn:after` 里 `completeSession()` 回报父会话 | `plugin-subtask/src/index.ts` |
| `plugin-persona` | `resolveConfig()` 取 `persona/disableOutputFormat/clientSideJsonRendering`（消费侧**窄化类型**，见 §5.2） | `plugin-persona/src/index.ts` |
| `plugin-session-manager` 自身 actions | WebUI 通过 action 调 `listSessions/createSession/getSessionTree/getInheritance/...`；`getSessionTree` 回分区的 `SessionTreeSection[]`（§2.2），`listSessions` 照旧回全部会话（含 IM 房间）；`getInheritance` 由服务端推出会话所属平台（§2.4），回继承值与每个键的来源层 | `plugin-session-manager/src/index.ts` |
| `plugin-paper` | `resolveConfig()` 取白纸与远端代理的房间键，决定房间用哪块白纸、每天能花多少 | `plugin-paper/src/rooms.ts` |
| `plugin-memory-vector` / `plugin-memory-history` / `plugin-tool-session` / `plugin-user-relation` | 每次检索或注入时 `resolveConfig()` 取 `memoryRecallScope`，按房间收窄召回范围（可选依赖，缺席时不收窄） | 各包 `src/` |

## 4. 写一个 provider（替换实现）

绝大多数作者**不需要**重写本服务——它是单一参考实现，替换它意味着接管整套生命周期 + 配置解析语义。若确有需要（如换持久化后端或自定义会话模型），按下表实现。

**最小必须**：接口里被实际消费的这几个方法务必正确——`createSession` / `getSession` / `listSessions` / `updateSession` / `ensureSession` / `createChildSession` / `completeSession` / `resolveConfig` / `getPlatformProfiles`。其余（`getTree` / `resolveInheritance` / `generateTitle` / ...）主要服务于 WebUI 与 `/session`，可保守实现。`SessionInfo.kind` 是必填字段，建档时要按 `parentId` 填上。

**配置解析的合并语义必须复刻**（否则 Agent 会拿错 LLM）：`resolveConfig` 优先级从高到低 = 会话自身 config > 父会话 `sessionDefaults` > 平台 profile > 全局 defaults，平台 profile 按 §2.4 钉死出生平台，且**返回结果必须删除 `sessionDefaults` 字段**（不传递给消费方）（`plugin-session-manager/src/index.ts`）。不钉死时，从 WebUI 驱动 IM 房间会拿到 webui 平台档的工具组。

**配置补丁是三态，不是二态**：键不出现 = 不改；键为 `null` = 删除该键、恢复继承；键为 `false` = **显式覆盖**，不等于未设置。参考实现里 `normalizeSessionConfigPatch` 把 `null` 转成 `undefined` 再交给 `updateSession` 删键，而 `stripUndefined` 只剔 `undefined` 与 `null`——因此显式 `false` 会一路压过继承来的 `true`（`plugin-session-manager/src/index.ts`）。WebUI 会话配置页的两个开关只写显式 `true` / `false` 两档：点一下就落成显式值，页面不提供回到「未设置」的入口，恢复继承要把该键从会话配置里清掉（补丁置 `null`）。

```ts
import { resolveSessionOrigin } from '@aalis/api-gateway';
import { llm } from '@aalis/api-llm';
import { memory } from '@aalis/api-memory';
import { persona } from '@aalis/api-persona';
import { sessionManager } from '@aalis/api-session-manager';
import type {
  InheritanceSource,
  PlatformProfile,
  SessionConfig,
  SessionInfo,
  SessionInheritance,
  SessionManagerService,
  SessionTreeNode,
} from '@aalis/api-session-manager';
import { type Events, definePlugin, events, logger, optional, provide } from '@aalis/core';

type Derived = 'kind' | 'originPlatform' | 'audience';

/** 种类、出生平台与受众只按 id 与 parentId 推出，不收调用方传值 */
function describe(id: string, parentId?: string): Pick<SessionInfo, Derived> {
  const origin = resolveSessionOrigin(id);
  if (parentId) return { kind: 'task', originPlatform: origin?.platform };
  return { kind: 'room', originPlatform: origin?.platform, audience: origin?.audience ?? 'owner' };
}

class MySessionManager implements SessionManagerService {
  private sessions = new Map<string, SessionInfo>();
  private profiles = new Map<string, PlatformProfile>();
  events!: Events;

  async createSession(opts: Partial<Omit<SessionInfo, 'id' | 'children' | 'createdAt' | 'updatedAt' | Derived>> = {}): Promise<SessionInfo> {
    const now = Date.now();
    const id = opts.parentId
      ? `${opts.parentId}::${crypto.randomUUID().slice(0, 8)}`
      : `session-${crypto.randomUUID().slice(0, 8)}`;
    const s: SessionInfo = {
      id,
      name: opts.name ?? id,
      parentId: opts.parentId,
      children: [],
      status: opts.status ?? 'active',
      config: opts.config ?? {},
      createdAt: now,
      updatedAt: now,
      createdBy: opts.createdBy ?? 'user',
      inputContext: opts.inputContext,
      metadata: opts.metadata,
      ...describe(id, opts.parentId),
    };
    this.sessions.set(id, s);
    if (s.parentId) this.sessions.get(s.parentId)?.children.push(id);
    await this.events.emit('session:created', s);
    return s;
  }
  getSession(id: string) {
    return this.sessions.get(id);
  }
  listSessions() {
    return [...this.sessions.values()];
  }
  async updateSession(id: string, updates: Partial<Pick<SessionInfo, 'name' | 'config' | 'status' | 'metadata'>>) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} 不存在`);
    Object.assign(s, updates, { updatedAt: Date.now() });
    await this.events.emit('session:updated', s);
    return s;
  }
  async ensureSession(id: string, patch?: Partial<Pick<SessionInfo, 'name' | 'config' | 'status' | 'metadata' | 'createdBy'>>) {
    const existing = this.sessions.get(id);
    if (existing) return this.updateSession(id, patch ?? {});
    const now = Date.now();
    const s: SessionInfo = {
      id,
      name: patch?.name ?? id,
      children: [],
      status: patch?.status ?? 'active',
      config: patch?.config ?? {},
      createdAt: now,
      updatedAt: now,
      createdBy: patch?.createdBy ?? 'user',
      metadata: patch?.metadata,
      ...describe(id),
    };
    this.sessions.set(id, s);
    await this.events.emit('session:created', s);
    return s;
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
    await this.events.emit('session:deleted', id);
  }
  async createChildSession(parentId: string, opts?: Partial<Omit<SessionInfo, 'id' | 'parentId' | 'children' | 'createdAt' | 'updatedAt' | Derived>>) {
    return this.createSession({ ...opts, parentId });
  }
  getChildren(parentId: string) {
    return this.listSessions().filter(s => s.parentId === parentId);
  }
  getTree(rootId?: string): SessionTreeNode[] {
    const toNode = (s: SessionInfo): SessionTreeNode => ({
      session: s,
      children: this.getChildren(s.id).map(toNode),
    });
    if (rootId) {
      const root = this.getSession(rootId);
      return root ? [toNode(root)] : [];
    }
    return this.listSessions()
      .filter(s => !s.parentId)
      .map(toNode);
  }
  async completeSession(id: string, result?: string) {
    const s = await this.updateSession(id, { status: 'completed' });
    s.result = result;
    await this.events.emit('session:completed', s);
  }
  resolveConfig(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'> {
    const out: Record<string, unknown> = { ...this.resolveInheritance(sessionId, platform).values };
    const s = this.sessions.get(sessionId);
    if (s) Object.assign(out, s.config);
    delete out.sessionDefaults;
    return out;
  }
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance {
    // 房间会话钉死出生平台，传入的入口平台只对没有出生平台的会话起作用（受众条目与全局 defaults 从略）
    const pinned = resolveSessionOrigin(sessionId)?.platform ?? platform;
    const values: Record<string, unknown> = {};
    const sources: SessionInheritance['sources'] = {};
    const layer = (config: object | undefined, source: InheritanceSource) => {
      for (const [key, value] of Object.entries(config ?? {})) {
        if (value === undefined || value === null) continue;
        values[key] = value;
        sources[key as keyof SessionConfig] = source;
      }
    };
    if (pinned) layer(this.profiles.get(pinned), 'platform');
    const s = this.sessions.get(sessionId);
    if (s?.parentId) layer(this.sessions.get(s.parentId)?.config.sessionDefaults, 'parent');
    delete values.sessionDefaults;
    delete sources.sessionDefaults;
    return { platform: pinned, values, sources };
  }
  getPlatformProfiles(): Record<string, PlatformProfile> {
    return Object.fromEntries(this.profiles);
  }
  getDefaults(): Omit<SessionConfig, 'sessionDefaults'> {
    return {};
  }
  async generateTitle(sessionId: string, userMessage?: string) {
    void sessionId;
    void userMessage;
    return undefined;
  }
  async updateSessionTitle(sessionId: string, title: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.title = title;
  }
}

export default definePlugin({
  name: '@me/plugin-session-manager',
  provides: [sessionManager],
  uses: { provide, events, logger, memory, llm: optional(llm), persona: optional(persona) },
  apply({ provide, events, logger, memory, llm, persona }) {
    void llm;
    void persona;
    if (memory.current === undefined) {
      logger.error('需要 memory 服务');
      return;
    }
    const mgr = new MySessionManager();
    mgr.events = events;
    provide(sessionManager, mgr, { label: '会话管理', priority: 50 });
  },
});
```

`package.json` **双源**必须与 `uses/provides` 一致（参考实现的样子，`plugin-session-manager/package.json`）：

```jsonc
"keywords": ["aalis", "aalis-plugin"],
"aalis": {
  "service": {
    "required": ["memory"],
    "optional": ["agent", "platform", "persona", "llm"],
    "provides": ["session-manager"]
  }
}
```

双源校验细节见 [清单元数据](../concepts/manifest-metadata.md)。同名竞争的胜出规则（preference > priority > 注册顺序）见 [服务模型](../concepts/service-model.md)。

## 5. 标准消费方式

### 5.1 惰性取用 + 可选降级

`session-manager` 在很多场景是**可选依赖**（`uses optional`）——它可能没装。每次用都现取，**不要缓存到字段**（provider bounce 会让旧引用失效，见 [惰性服务访问](../concepts/lazy-service-access.md)）：

```ts
// Agent 的标准写法（plugin-agent/src/index.ts）
const sm = sessionManager.current;
const resolved = sm && sessionId ? sm.resolveConfig(sessionId, platform) : undefined;
// sm 缺失 → resolved 为 undefined → 回落到全局 ServicePreference / 默认行为，不致中断
```

写操作的标准错误边界是「服务不可用即报错或返回错误对象」，参考 action 写法 `if (!sm) throw new Error('session-manager 服务不可用')`（`plugin-session-manager/src/index.ts`）或工具里 `return JSON.stringify({ error: 'session-manager 服务不可用' })`（`plugin-subtask/src/index.ts`）。

### 5.2 消费侧窄化类型（推荐）

只用到 `resolveConfig` 的少数字段时，可声明一个**窄接口**而非 import 全量 `SessionManagerService`，避免包循环 / 不必要依赖。`plugin-persona` 采用此方式（`plugin-persona/src/index.ts`）：

```ts
interface SessionConfigResolver {
  resolveConfig(sessionId: string, platform?: string):
    { persona?: string; disableOutputFormat?: boolean; clientSideJsonRendering?: boolean };
}
const sm = sessionManager.current;
```

### 5.3 监听生命周期事件

子任务完成感知就是事件驱动：`completeSession()` 发 `session:completed`，等待方据此收尾（`plugin-session-manager/src/index.ts`）。

## 6. 配置 / 风险 → 影响（provider 与 consumer 必守）

### 6.1 `resolveConfig` 是 Agent 行为的单一事实源

LLM 选择、persona、工具分组、是否结构化输出全部从这里来。Provider 若漏掉某层合并或不删 `sessionDefaults`，会导致 Agent 静默用错模型 / 人设——四层合并顺序（§4）与 `sessionDefaults` 剥离必须完整复刻，缺一层就会让消费方拿到错误的生效配置。

### 6.2 会话隔离边界

`sessionId` 是隔离边界：`deleteSession` 会**递归删子会话**并经 `memory:clear` 钩子清空该会话历史（`plugin-session-manager/src/index.ts`）。消费方不要跨 `sessionId` 复用配置或历史。

### 6.3 子任务指令走顶层 `inputContext`（关键约定）

父会话给子任务下达的指令通过 **顶层 `SessionInfo.inputContext`** 传递，而非写入 `metadata`：

- 写入：`plugin-subtask` `createChildSession(parentId, { inputContext: task, ... })`（`plugin-subtask/src/index.ts`）。
- 读取：子任务上下文注入中间件读 `session.inputContext`（顶层，`plugin-subtask/src/index.ts`）；返回给父会话时也是 `session.inputContext`（`plugin-subtask/src/index.ts`）。

实现的 `createSession` 兼容两种来源但**顶层优先**：`inputContext: opts?.inputContext ?? (opts?.metadata?.inputContext)`（`plugin-session-manager/src/index.ts`）。Provider 必须保证 `inputContext` 能从顶层读出来——**只写入 metadata 不写顶层会让子任务读不到任务指令**。

### 6.4 子任务不可嵌套

`plugin-subtask` 在创建前检查 `parentSession?.parentId`，禁止子任务再开子任务（`plugin-subtask/src/index.ts`）。这是消费侧约定，不是服务硬约束——自定义协调器若复用会话树请自行守住，否则会无限递归派发。

### 6.5 标题生成会调 LLM

`generateTitle` 会真发一次 LLM `chat`（`think:false`，`temperature:0.3`），有成本与延迟；参考实现只对 `webui` / `cli` 平台自动触发，且异步不阻塞消息处理（`plugin-session-manager/src/index.ts`）。第三方平台自动调用前请自行权衡。

平台派生的会话 id（`cli-default` 等）从不经 `createSession` 预建，首条消息到达时**缺档是常态**：参考实现先 `ensureSession` 兜底建档再生成标题（与 `createChildSession` 同一条兜底路），因此这些平台的首条消息一样会拿到标题。兜底只看入口平台：`cli` / `webui` 平台上带未知 `sessionId` 的入站消息都会建档，包括定时任务投给已删除会话的那种；有出生平台的 IM 房间除外，从 WebUI 往房间插话既不生成标题，也不经这里建档（房间由 §6.6 的收录登记）。

### 6.6 IM 房间收录

参考实现在 `inbound:message` 上收录 IM 房间：有出生平台、不是子任务（id 不含 `::`）的会话，首条真人入站（不带 `source`）到达即登记，与是否执行过 `/session.set`、开过子任务无关。带 `source` 的是内部注入（workflow 的 send-message 与 agent 节点、定时任务、空闲开话题、宿主通知、好友申请与入群邀请的合成通知），不触发登记，每次 workflow 运行不会多出一个持久的房间。

- 登记：`ensureSession(id, { name, createdBy: 'system', status: 'waiting' })`，得到 `kind: 'room'` 与房间自己的 `audience`、`originPlatform`。收录只登记与补名，不改状态；状态翻转见 §7.1。
- 取名按受众：群取消息的 `groupName`，私聊取 `nickname`，缺省用会话 id。只采信出生平台自己的入站（`msg.platform` 等于出生平台）带的名字，从 WebUI 插话建档时名字为 id，不会把私聊房间起成 owner 的昵称。群的首条入站可能是不带群名的戳一戳，这时同样用 id，不回退到发送者昵称。
- 补名：现名还等于 id 时，后到的出生平台原生入站带了群名（群）或昵称（私聊）就补上；现名不是 id 的（如 owner 用 `/session.set -n` 起的名）不改。`createChildSession` 兜底建档的房间同样以 id 为名，由之后的真人入站补名。
- 前缀告警：出生平台既不是发来消息的平台、也不是已注册的平台名时，按前缀告警一次，多半是适配器的 id 前缀与平台名不一致（见 [platform 服务](platform.md) 的会话 ID 约定）。
- 规模：每个来过真人消息的群与私聊都登记一次，没有上限。会话表按整表快照落盘（§7.3），每次写的条数随房间数线性增长。

删除 IM 房间与删除其他会话相同，走 scope 为 session 的 `memory:clear`（§6.2），清空它在 Aalis 里的消息历史与长期记忆（摘要、向量记忆等），聊天平台里的消息不受影响；房间之后再来真人消息会重新登记，记忆从零开始。

### 6.7 房间键不随复制冻结

白纸与远端代理的六个键（`ROOM_ONLY_CONFIG_KEYS`：`paperEnabled`、`paperName`、`remoteAgentTypes` 与三项每日上限）只经继承链实时解析。任何「复制生效配置建新会话」的路径都要先经 `omitRoomOnlyKeys()` 去掉它们：复制会把当时的值冻结进新会话，此后房间或平台档改了不跟着变，子会话还会凭冻结的值继续开远端任务。第一方的两条复制路径（WebUI 页面动作 `createSession`、plugin-subtask 的 `create_subtask`）都已经这样做。

`memoryRecallScope` 相反，必须随子会话复制：子会话不带上更窄的召回范围，经子任务就绕过了收窄。

onebot 等平台派生的房间会话（如 `onebot:<self>:group:<群>`）在首条真人入站到达时由 §6.6 的收录登记，之后就出现在会话列表里，能在 WebUI 会话页编辑这些键。

## 7. 注意事项与边界情形

### 7.1 会话状态：回合开始时翻 `active`，同一个中间件收口

参考实现只在回合真正开始时把会话翻成 `active`（「进行中」）：翻转挂在 `agent:input:before` 中间件上，入站消息本身不改状态，群里只有消息、agent 没有开始回合（被触发判定挡下）的房间不会显示「进行中」。同一个中间件把 `next()` 包在 `try/finally` 里，`finally` 把仍为 `active` 的根会话收口为 `completed`（`plugin-session-manager/src/index.ts`）：

- `next()` 正常返回时整轮已经跑完，`agent:turn:after` 也已执行；
- 排在它后面的输入中间件不调用 `next()` 拦下消息，或者抛错时，agent 既不发 `agent:turn:after` 也不发 `outbound:message`，由这里的 `finally` 收口，会话不会停在「进行中」；
- 排在它前面的中间件拦下消息时，它根本不运行，会话也不会被翻成 `active`。

正常结束另有两路收口：`outbound:message`（产生了回复）与 `agent:turn:after` 中间件（replied / silent / aborted / error 四种结局都会发）。三路都只收口根会话，重复收口无副作用；子会话由 plugin-subtask 收口。

边界：未装 agent 时没有回合，会话不会翻 `active`；非 `active` 的会话（包括已归档的）在新一轮开始时一律翻回 `active`；关停时仍为 `active` 的会话由 `onDrain` 收口（§7.3）。

### 7.2 配置解析是同步快照

`resolveConfig` 读内存 Map，不 `await`、不持久等待。若你在 provider 切换瞬间调用，可能拿到旧 manager 的快照——遵守 §5.1「每次现取」即可。

### 7.3 持久化是延迟刷盘 + 拆卸落盘

写操作走 `markDirty()` → 1s 防抖刷盘。`App.stop()` / bounce / unload 时：`lifecycle.onDrain` 调用 `settleActiveOnDrain()`，把仍为 `active` 的会话收口为 `completed` 并立刻落盘（`waiting` / 已终态不动；不依赖 agent 钩子）。随后 `lifecycle.onDispose(() => manager.shutdown())` 再刷一次（`shutdown()` 幂等：清定时器 + 置 dirty + `persist()`）（`plugin-session-manager/src/index.ts`）。session-manager 对 memory 是普通依赖：关停以激活为单位分 drain / close，消费者整个 close 完提供者才 drain，因此 drain / `onDispose` 落盘期间 memory 仍在。单独卸载 / 禁用 / 重载 memory 时，本插件作为正在用它的 required 下游并入同一批先关，落盘同样成立。会话表跟随 memory 的当前胜者：运行中胜者换成另一个后端时，先把未落盘的变更写回旧后端，再从新后端读取会话表整体替换，不跨后端合并；新表加载完成前的改动仍写回旧后端，旧后端已卸载或停用时写回失败，只记 warn。读取会话表失败时按 1、3、10 秒的间隔重试三次（每次重试前记一条 warn），其间仍用原来的会话表与落盘目标。本插件激活时（启动时，或随 memory 胜者卸载、停用、重载而重新激活时）等读表（含重试）结束才对外提供服务：后端持续不可用时，这次重算约多等 14 秒，拓扑序排在本插件之后的插件随之推迟激活，启动时 `app:ready` 也随之推迟。14 秒是三次重试间隔之和，各次读取本身的耗时另计：如 memory-mongodb 连不上库时，每次读取要等到服务器选择超时（`connectTimeoutMs`，默认 5 秒）。换后端、停用或停机会中止重试等待。重试用尽或被中止时会话列表为空，在这个后端上的会话改动不落盘，以免空表覆盖后端原有记录；重试用尽记 error，被中止（停用、停机或换后端）只记一行 info。崩溃（非正常退出）可能丢失最后 ~1s 的会话元数据变更。重写 provider 时若要更强一致性，请在关键写操作后同步落盘。

## 8. 交叉链接

- [服务模型](../concepts/service-model.md) —— DI 按名解析、同名竞争（preference > priority > 注册顺序）。
- [惰性服务访问](../concepts/lazy-service-access.md) —— 为何每次 `current`、不要缓存。
- [清单元数据](../concepts/manifest-metadata.md) —— `provides`/`uses` 与 `package.json aalis.service` 双源同步与校验。
- [消息-LLM 流水线](../concepts/message-llm-pipeline.md) —— `resolveConfig` 的产物如何进入 `agent:input:before` / `agent:llm:before` / `agent:turn:after`。
- [Agent 服务](agent.md) —— 头号消费方。
- [Memory 服务](memory.md) —— 会话元数据与历史的持久化后端。
- [会话级工具状态服务](tool-session.md) —— 按 `sessionId` 隔离的工具态，与本服务共享同一隔离边界。
- [Persona 服务](persona.md) / `plugin-persona` —— 消费侧窄化类型范例（§5.2）。

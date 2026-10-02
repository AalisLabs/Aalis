# api-session-manager — 会话、会话设置与树形管理契约

**包名**: `@aalis/api-session-manager`  
**源码**: `packages/api-session-manager/src/index.ts`  
**实现**: `@aalis/plugin-session-manager`

## 概述

定义会话树形层级、会话种类，以及会话设置的登记、存储、继承与解析。会话设置项（模型、人设、工具分组、白纸开关……）由拥有这项功能的插件登记，本契约与会话管理不认识任何具体的键：登记过的键按登记的字段校验与解析，插件没装或没启用时它的键原样留在存储里，不显示、不参与解析，重新启用后恢复。Agent 等消费方经 `resolveConfig()` 取一个会话的生效配置。

## 会话设置

### 值的类型

```ts
/** 各设置项的值；键由登记它的插件经 declaration merging 注入，每个键都可选（没有即继承上层） */
interface SessionConfig {}

/** 会话档案里存的配置：会话自己的覆盖；sessionDefaults 是旧数据里父会话给子会话的默认值，解析照常生效，不再有写入口 */
type StoredSessionConfig = SessionConfig & { sessionDefaults?: SessionConfig };

/** 写会话或某一层：给值即写入（按登记的字段校验），null 删掉这一项、恢复继承，没给的键不动 */
type SessionConfigPatch = { [K in keyof SessionConfig]?: SessionConfig[K] | null };
```

插件给 `SessionConfig` 加键的写法与 `AalisEvents` 相同：

```ts
declare module '@aalis/api-session-manager' {
  interface SessionConfig {
    persona?: string;
  }
}
```

### 登记设置项

```ts
type SettingProminence = 'composer' | 'common' | 'advanced';

interface SessionSetting {
  key: keyof SessionConfig & string;   // 先经 declaration merging 加进 SessionConfig
  field: SchemaField;                  // schema-config 字段：类型、标签、说明、校验、可选项来源（dynamicOptions）
  appliesTo: readonly SessionKind[];   // 适用的会话种类
  prominence: SettingProminence;
  order?: number;                      // 同一显眼程度里的先后，小的在前；不写的排在后面
  liveOnly?: boolean;                  // 只经继承链实时解析：建子会话复制配置时不带它
  validate?(value: unknown): string | undefined;  // 取值校验：合法回 undefined，否则回原因；外来字段类型必须给
}

interface RegisteredSessionSetting extends SessionSetting {
  plugin: string;                      // 登记它的插件实例 id
}
```

插件经绑定门面登记，随它的激活撤回：

```ts
const uses = { sessionManager: optional(sessionManager) };
// apply 里
sessionManager.registerSetting({
  key: 'persona',
  field: { type: 'select', label: '人设', dynamicOptions: 'persona', allowCustom: true },
  appliesTo: ['owner', 'room', 'task'],
  prominence: 'common',
});
```

会话管理换提供者时，门面把登记整体重挂到新的提供者上；会话管理不在时登记先记在账上，它上线时挂上。

- **显眼程度：** `composer` 也出现在输入框旁的快捷切换，同一会话最多两项，多出的按 `order` 退到 `common`；`common` 在设置里排在前面；`advanced` 收进默认折叠的「高级」，按登记它的插件分组。
- **字段：** 写入时按它校验，不合的拒绝。存储里不合它的值（旧数据、手写的配置文件）解析时当作没设置，同一处只告警一次；字段标了 `onInvalid: 'error'` 的，原值原样交出、不回落到下面的层，由登记它的插件按拒绝处理（例如金额上限写坏了按 0，不能退成不限）。没有任何一层设置时解析结果里没有这个键，`field.default` 只供界面显示，须与「没有这个键」时的行为一致。
- **取值校验：** `validate` 在写入与解析时先于字段校验，回了原因的与不合字段同样处理。schema-config 不校验外来字段类型（如 `llm-ref`）的取值，外来类型的设置项不给 `validate` 时登记抛错。plugin-agent 的 `llm` 只收服务与模型都是非空字符串的 `{ provider, model }`。
- **同一个键几个插件登记：** 须是同一份内容的定义（逐项深比较，`validate` 比较函数本身），不必是同一个对象：进程里装了两份契约包时，两份导出的定义也认作同一份。几个插件共同遵守的设置项由契约包导出定义、各自登记，只要还有一个登记者在场，这一项就有效；`listSettings()` 里归最先登记、仍在场的那个插件。内容不同的登记抛错。
- 键不能是空串、`sessionDefaults` 或原型链上的名字，`appliesTo` 与 `prominence` 取值不对的登记抛错。
- 登记与撤回都发 `session:config:changed`。

第一方登记的设置项：

| 键 | 登记者 | 适用 | 显眼程度 |
|---|---|---|---|
| `llm` | [plugin-agent](../plugins/plugin-agent.md) | 全部 | composer |
| `think`、`maxToolIterations` | plugin-agent | 全部 | common、advanced |
| `persona`、`systemPromptExtra` | [plugin-persona](../plugins/plugin-persona.md) | 全部 | common |
| `disableOutputFormat`、`clientSideJsonRendering` | plugin-persona | 全部 | advanced |
| `enabledToolGroups` | [plugin-tools](../plugins/plugin-tools.md) | 全部 | common |
| `memoryRecallScope` | 跨会话取料的插件各自登记 `MEMORY_RECALL_SCOPE_SETTING`（[api-memory](./api-memory.md)） | 全部 | advanced |
| `paperEnabled`、`paperName`、`remoteAgentTypes` 与三项每日上限 | [plugin-paper](../plugins/plugin-paper.md) | 房间 | advanced，liveOnly |

### 会话之上的各层

```ts
type SessionConfigLayer =
  | { scope: 'defaults' }                                                   // 全局默认
  | { scope: 'platform'; platform: string }                                 // 平台档，按平台名生效，不区分适配器实例
  | { scope: 'audience'; platform: string; audience: 'group' | 'private' }; // 平台档的受众条目，只对这个平台的群或私聊房间
```

各层存放在宿主配置文档（`@aalis/api-host-config`）的 `sessionConfig` 字段里，由会话管理读写：

```yaml
sessionConfig:
  defaults:
    persona: aalis
  platforms:
    cli:
      enabledToolGroups: ['*']
    onebot:
      enabledToolGroups: [search]
  audiences:
    onebot:
      private:
        enabledToolGroups: [search, scheduler]
```

它们是「下次启动用什么」的配置，跟着配置文件走，可以手写，也由脚手架生成。插件配置的 schema 词汇（`map` 只收字符串值）装不下任意类型的设置值，所以不放在会话管理的插件配置里。文档里形状不对的部分（某层不是对象、受众不是 `group` 或 `private`）与 `sessionConfig` 下不认识的键（如拼错的 `platfroms`）告警一次后忽略，按层写时不再写回。宿主没有提供配置文档时各层为空、按层写被拒。

### 继承与解析

从高到低：

1. 会话自身 `config`
2. 父会话的 `sessionDefaults`（旧数据）
3. 平台档的受众条目（只对有出生平台的房间）
4. 平台档
5. 全局默认

哪一层都没设的项，消费方按「没有这个键」处理（例如 `llm` 没设时 agent 用 llm 服务的偏好）。

**房间会话钉死出生平台：** 平台档按哪个平台选：会话有出生平台（api-gateway 的 `resolveSessionOrigin`，子任务按父会话算）时按出生平台，忽略调用方传入的 `platform`，并按它的受众叠加受众条目；没有出生平台的 owner 面会话（WebUI、CLI 等）按传入的入口平台，不取受众条目。因此从 WebUI 往 QQ 群插话，这一轮仍按 onebot 的平台档选工具组、人设与模型。`resolveConfig` 与 `resolveInheritance` 同一选法。

```ts
type InheritanceSource = 'defaults' | 'platform' | 'audience' | 'parent';

interface SessionInheritance {
  platform?: string;                 // 选档用的平台
  audience?: 'group' | 'private';    // 选档用的受众：只有房间会话带
  values: SessionConfig;             // 继承值（不含会话自身 config）：已登记、取值合法的键
  sources: Record<string, InheritanceSource>;  // 每个键来自哪一层
}
```

`resolveInheritance` 只看继承值，才不会把会话自己的覆盖当成继承来的；会话设置的来源显示与 `/session` 用它。

### 写入

`createSession`、`createChildSession`、`ensureSession`、`updateSession` 的 `config` 与 `updateLayer` 的补丁都按登记的设置项校验：没登记的键（提供它的插件没装或没启用）、不合字段的值抛 `SessionConfigError`，什么都不改；`null` 删掉这一项，没登记的键也能删。用 `isSessionConfigError(err)` 判定，不用 `instanceof`。`sessionDefaults` 不是设置项，写不进去。改了配置（`updateSession` 带 `config`、`updateLayer`）发 `session:config:changed`。

`updateLayer` 写进宿主配置文档并保存：保存成功后发事件；保存失败（拒写或写盘出错）时撤回文档里的改动，以拒绝传出。

### 建子会话

`childConfig(parentId, platform)` 给出父会话的生效配置去掉 `liveOnly` 项，建子会话时复制它：会话服务的 `session/create` 与 [plugin-subtask](../plugins/plugin-subtask.md) 的 `create_subtask` 都用它。复制会把当时的值冻结进新会话，`liveOnly` 的项（白纸与远端代理）不冻结，免得子会话凭冻结的值继续开远端任务；`memoryRecallScope` 照常复制，否则经子任务就绕过了收窄。

## 会话

```ts
type SessionKind = 'owner' | 'room' | 'task';
type RoomAudience = 'owner' | 'private' | 'group';

/** 子会话为 task，受众为群或私聊为 room（含 owner 自己的私聊），其余为 owner */
function sessionKind(session: Pick<SessionInfo, 'parentId' | 'audience'>): SessionKind;

interface SessionInfo {
  id: string;
  name: string;
  title?: string;
  parentId?: string;
  children: string[];
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  config: StoredSessionConfig;     // 原样存储：含没启用的插件的键
  createdAt: number;
  updatedAt: number;
  createdBy?: 'user' | 'agent' | 'scheduler' | 'system';
  inputContext?: string;
  result?: string;
  metadata?: Record<string, unknown>;
  kind: SessionKind;               // sessionKind 的结果
  originPlatform?: string;         // 出生平台（api-gateway 的 resolveSessionOrigin）；owner 面会话及其子会话没有
  audience?: RoomAudience;         // 只有根会话带：有出生平台的取 group 或 private，其余为 owner
  originInstance?: string;         // 有出生平台的房间：接管它的平台适配器的插件实例 id；只供列表分组
  lastReplyAt?: number;            // 她最近一次开口的时间：回合结局为 replied 时写入
}

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}
```

会话种类是会话列表的分区、设置项的 `appliesTo` 与会话协议的 `SessionSummary.kind` 共同的来源。它与审批的发起类别是两回事：owner 在自己的 QQ 私聊里亲手发起的回合照样能产生审批。

`kind`、`originPlatform`、`audience` 由 session-manager 只按会话 ID 与 `parentId` 推出，新建、建档与加载时覆盖写入，调用方传的值与存储里的旧值都不采信；`createSession`、`createChildSession` 的参数类型里没有这三个字段，也没有下面两个由 session-manager 写入的字段。

- `originInstance`：有出生平台的房间建档时，用 `@aalis/api-platform` 的 `resolvePlatformBySession` 解析出接管它的适配器条目，记下它的插件实例 id（`contextId`），落盘保存，记下后不再重算。会话列表据此把同一插件的多个实例分组显示；路由不读它，平台动作仍按会话 ID 实时路由。还没有适配器认领（适配器没装好、连接还没上来、账号暂时不属于任何实例）的为 undefined，下一条真人入站时重新解析，认领到就补记并发 `session:updated`；同一条记录已有解析在途的不重复解析。`ensureSession` 建档时先建好记录、发 `session:created`，记下实例后再发 `session:updated`，等它落定才返回；命中已有的记录时只合并更新，不解析。
- `lastReplyAt`：回合结局（`agent:turn:after` 的 `outcome`）为 `replied` 时写入，`silent`、`aborted`、`error` 不改；同一会话别的回合还在跑时同样写入，随 `session:updated` 推出。

`status` 的变化：回合开始时翻 `active`；会话里最后一轮结束时，仍为 `active` 的根会话按这一轮的结局收口，结局为 `error` 的收口为 `error`，其余（含消息被拦下、没有结局的一轮）为 `completed`。子会话由 plugin-subtask 收口。`audience: 'owner'` 只表示「不是 IM 房间」，凡是没有出生平台的根会话都算，包括 `mcp-server`、`workflow::<id>` 与定时任务指定的目标会话，不代表 owner 本人在场。非房间会话的 ID 不得含单冒号，否则会被当成房间。

## 服务接口（节选）

描述符 `sessionManager`（`name: 'session-manager'`），绑定接口 `BoundSessionManager` 是 `ServiceRef<SessionManagerService>` 加上 `registerSetting(setting)`。

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

  registerSetting(setting: SessionSetting, plugin: string): () => void;  // 提供者一侧；插件用绑定门面
  listSettings(): RegisteredSessionSetting[];
  resolveConfig(sessionId: string, platform?: string): SessionConfig;
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance;
  getOwnConfig(sessionId: string): SessionConfig;                 // 会话自己的覆盖里已登记、取值合法的项
  childConfig(parentId: string, platform?: string): SessionConfig;
  listLayers(): SessionConfigLayer[];                             // 文档里写了的各层，全局默认总在第一个
  getLayer(layer: SessionConfigLayer): SessionConfig;             // 这一层自己的值
  resolveLayer(layer: SessionConfigLayer): Pick<SessionInheritance, 'values' | 'sources'>;  // 解析到这一层为止
  updateLayer(layer: SessionConfigLayer, patch: SessionConfigPatch): Promise<void>;

  generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
}
```

> 完整签名以源码 `index.ts` 为准；上面是消费方最常用的部分。

事件：`session:created`、`session:updated`、`session:completed`、`session:deleted`，以及 `session:config:changed`（不带参数：设置项登记或撤回、某一层或某个会话的覆盖被改写），会话服务据此推 `session/config/changed`。

## 实现者

- [@aalis/plugin-session-manager](../plugins/plugin-session-manager.md) — 会话元数据持久化到 `MemoryService` 的 `sessions` namespace，各层读写宿主配置文档

## 相关

- `/session`、`/model`、`/persona` 等指令由 [plugin-agent](../plugins/plugin-agent.md) 注册（不是 session-manager）
- 会话设置在会话协议上的读写见 [api-session-protocol](./api-session-protocol.md)

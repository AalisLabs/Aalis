# 会话管理服务（session-manager）

> 受众：编写或消费「会话生命周期 + 会话级配置解析」的第三方插件作者。
> 先读 [服务模型](../concepts/service-model.md) 与 [惰性服务访问](../concepts/lazy-service-access.md)；本文是它们在「会话」这个具体服务上的落点。配置如何流入 LLM 调用见 [消息-LLM 流水线](../concepts/message-llm-pipeline.md)。

## 1. 定位

一句话：**维护对话会话的生命周期（创建/查询/状态/树形父子关系）并把分层会话配置合并成「最终生效配置」交给 Agent 消费。** 取用名 `getService<SessionManagerService>('session-manager')`，契约包 `@aalis/plugin-session-manager-api`，参考实现 `@aalis/plugin-session-manager`。

核心职责两件：

- **配置解析**：会话自身 config → 父会话 `sessionDefaults` → 平台 profile → 全局 defaults，按优先级合并出一份 `resolveConfig(sessionId, platform)`（`plugin-session-manager-api/src/index.ts:148-154`、实现 `plugin-session-manager/src/index.ts:798-829`）。Agent 每条消息都查它来决定用哪个 LLM / persona / 工具分组。
- **生命周期与会话树**：CRUD + 父子树 + `active/waiting/completed/error/archived` 状态机；会话状态由本插件**自治维护**（监听 `inbound:message` / `outbound:message` / `agent:turn:after`），并通过 `session:*` 事件广播（`plugin-session-manager/src/index.ts:967-999`）。

它**不是**消息存储——历史消息存在 `memory` 服务里；本服务只把会话元数据持久化到 `memory` 的 metadata 命名空间 `sessions`（`plugin-session-manager/src/index.ts:108, 448-466`）。

## 2. 契约（`@aalis/plugin-session-manager-api/src/index.ts`）

### 2.1 服务接口 `SessionManagerService`（`index.ts:112-187`）

```ts
// CRUD
createSession(opts?: Partial<Omit<SessionInfo, 'id'|'children'|'createdAt'|'updatedAt'>>): Promise<SessionInfo>;
getSession(id: string): SessionInfo | undefined;
listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
updateSession(id: string, updates: Partial<Pick<SessionInfo, 'name'|'config'|'status'|'metadata'>>): Promise<SessionInfo>;
deleteSession(id: string): Promise<void>;            // 同时清理其消息历史

// 树形
createChildSession(parentId: string, opts?: Partial<Omit<SessionInfo, 'id'|'parentId'|'children'|'createdAt'|'updatedAt'>>): Promise<SessionInfo>;
getChildren(parentId: string): SessionInfo[];
getTree(rootId?: string): SessionTreeNode[];

// 生命周期
completeSession(id: string, result?: string): Promise<void>;   // 触发 session:completed

// 配置解析（同步，非 Promise）
resolveConfig(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'>;
resolveInheritedDefaults(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'>;
getDefaults(): Omit<SessionConfig, 'sessionDefaults'>;
getPlatformProfiles(): Record<string, PlatformProfile>;
setPlatformProfile(platform: string, profile: PlatformProfile): void;

// 标题
generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined>;  // 调 LLM 总结
updateSessionTitle(sessionId: string, title: string): Promise<void>;
```

注意 `resolveConfig` / `resolveInheritedDefaults` / `getDefaults` / `getPlatformProfiles` 是**同步**方法（直接读内存 Map），别 `await`。

### 2.2 重要类型

`SessionConfig`（`index.ts:23-45`）——会话级覆盖，全部字段可选：

```ts
interface SessionConfig {
  llm?: { provider: string; model: string };  // provider = LLM 插件实例 contextId（如 @aalis/plugin-openai:main）
  enabledToolGroups?: string[];
  persona?: string;                            // 人格文件名（不含后缀）
  systemPromptExtra?: string;
  maxToolIterations?: number;
  disableOutputFormat?: boolean;               // 该会话回复纯文本，不走结构化输出
  clientSideJsonRendering?: boolean;           // 保留完整 JSON 给前端渲染
  sessionDefaults?: Omit<SessionConfig, 'sessionDefaults'>;  // 子会话继承的默认（解析结果里会被剥掉）
}
```

`PlatformProfile = SessionConfig`（`index.ts:54`）——每个平台一份模板。

`SessionInfo`（`index.ts:62-89`）——会话本体：

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
  inputContext?: string;           // ★ 父会话传入的指令/上下文（见 §6.3）
  result?: string;                 // 子会话完成后填，供向父会话汇报
  metadata?: Record<string, unknown>;
}
```

`SessionTreeNode = { session: SessionInfo; children: SessionTreeNode[] }`（`index.ts:96-99`，递归）。

### 2.3 事件 augmentation（`index.ts:189-197`）

本 `-api` 包通过 `declare module '@aalis/core'` 增量声明了四个生命周期事件到 `AalisEvents`：

```ts
'session:created':   [session: SessionInfo];
'session:updated':   [session: SessionInfo];
'session:completed': [session: SessionInfo];
'session:deleted':   [sessionId: string];
```

**只想监听这些事件**（而不调用服务）的插件也应当依赖本 `-api` 包——它锚定了 `import type {} from '@aalis/core'` 让 augmentation 生效（`index.ts:9`）。`plugin-file-reader` 就是仅为 `session:deleted` 事件而 `import type {} from '@aalis/plugin-session-manager-api'`（`plugin-file-reader/src/index.ts:8`）。

## 3. 谁提供 / 谁消费

**提供方（唯一参考实现）**：`@aalis/plugin-session-manager`，在 `apply()` 里 `ctx.provide('session-manager', manager, { label: '会话管理' })`（`plugin-session-manager/src/index.ts:963-965`）。它 `inject.required = ['memory']`、`optional = ['agent','platform','persona','llm']`（`index.ts:34-38`）。没有 `memory` 时直接拒绝启动（`index.ts:947-950`）。

**典型消费点**：

| 消费方 | 用法 | file:line |
| --- | --- | --- |
| `plugin-agent` | 每条消息 `resolveConfig()` 决定 LLM / persona / 工具分组 | `plugin-agent/src/index.ts:108-112, 451-464` |
| `plugin-subtask` | `createChildSession(parentId, { inputContext: task, ... })` 派发子任务；`agent:turn:after` 里 `completeSession()` 回报父会话 | `plugin-subtask/src/index.ts:171-177, 671-712` |
| `plugin-persona` | `resolveConfig()` 取 `persona/disableOutputFormat/clientSideJsonRendering`（消费侧**窄化类型**，见 §5.2） | `plugin-persona/src/index.ts:36-44, 653-655` |
| `plugin-session-manager` 自身 actions | WebUI 通过 action 调 `listSessions/createSession/getResolvedConfig/...` | `plugin-session-manager/src/index.ts:131-377` |

## 4. 写一个 provider（替换实现）

绝大多数作者**不需要**重写本服务——它是单一参考实现，替换它意味着接管整套生命周期 + 配置解析语义。若确有需要（如换持久化后端或自定义会话模型），按下表实现。

**最小必须**：接口里 8 个被实际消费的方法务必正确——`createSession` / `getSession` / `listSessions` / `updateSession` / `createChildSession` / `completeSession` / `resolveConfig` / `getPlatformProfiles`。其余（`getTree` / `resolveInheritedDefaults` / `generateTitle` / ...）主要服务于 WebUI，可保守实现。

**配置解析的合并语义必须复刻**（否则 Agent 会拿错 LLM）：`resolveConfig` 优先级从高到低 = 会话自身 config > 父会话 `sessionDefaults` > 平台 profile > 全局 defaults，且**返回结果必须删除 `sessionDefaults` 字段**（不传递给消费方）（`plugin-session-manager/src/index.ts:798-829`）。

```ts
// my-session-manager/src/index.ts —— 可编译最小骨架
import type { Context, PluginModule } from '@aalis/core';
import { ServicePriority } from '@aalis/core';
import type {
  PlatformProfile, SessionConfig, SessionInfo, SessionManagerService, SessionTreeNode,
} from '@aalis/plugin-session-manager-api';

export const name = '@me/plugin-session-manager';
export const inject = { required: ['memory'] as const, optional: ['llm', 'persona'] as const };
export const provides = ['session-manager'];   // ← 与 package.json aalis.service.provides 同步

class MySessionManager implements SessionManagerService {
  private sessions = new Map<string, SessionInfo>();
  private profiles = new Map<string, PlatformProfile>();
  constructor(private ctx: Context) {}

  async createSession(opts = {}): Promise<SessionInfo> {
    const now = Date.now();
    const id = opts.parentId ? `${opts.parentId}::${crypto.randomUUID().slice(0, 8)}`
                             : `session-${crypto.randomUUID().slice(0, 8)}`;
    const s: SessionInfo = {
      id, name: opts.name ?? id, parentId: opts.parentId, children: [],
      status: opts.status ?? 'active', config: opts.config ?? {},
      createdAt: now, updatedAt: now, createdBy: opts.createdBy ?? 'user',
      // ★ 顶层 inputContext 是子任务指令的权威来源——必须落到顶层字段
      inputContext: opts.inputContext ?? (opts.metadata?.inputContext as string | undefined),
      metadata: opts.metadata,
    };
    this.sessions.set(id, s);
    if (s.parentId) this.sessions.get(s.parentId)?.children.push(id);
    await this.ctx.emit('session:created', s);   // 别忘了发事件
    return s;
  }

  resolveConfig(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'> {
    const out: Record<string, unknown> = {};
    if (platform) Object.assign(out, this.profiles.get(platform) ?? {});      // 3 平台 profile
    const s = this.sessions.get(sessionId);
    if (s?.parentId) Object.assign(out, this.sessions.get(s.parentId)?.config.sessionDefaults ?? {}); // 2
    if (s) Object.assign(out, s.config);                                       // 1 会话自身（最高）
    delete out.sessionDefaults;                                                // ★ 必删
    return out;
  }
  // getSession / listSessions / updateSession / createChildSession /
  // completeSession / getPlatformProfiles ... 同理实现
}

export const apply: PluginModule['apply'] = async ctx => {
  if (!ctx.hasService('memory')) { ctx.logger.error('需要 memory 服务'); return; }
  const mgr = new MySessionManager(ctx);
  ctx.provide('session-manager', mgr, {
    label: '会话管理',
    // 想抢在参考实现之上：priority 高于 Backend(0)，或让 owner 用 preferService 选你
    priority: ServicePriority.Override,
  });
};
```

`package.json` **双源**必须与 `export const inject/provides` 一致（参考实现的样子，`plugin-session-manager/package.json`）：

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

双源校验细节见 [清单元数据](../concepts/manifest-metadata.md)。同名竞争的胜出规则（preference > priority > 注册顺序，`ServicePriority` = Backend 0 / Override 50 / System 200）见 [服务模型](../concepts/service-model.md)。

## 5. 标准消费姿势

### 5.1 惰性取用 + 可选降级

`session-manager` 在很多场景是**可选依赖**（`inject.optional`）——它可能没装。每次用都现取，**不要缓存到字段**（provider bounce 会让旧引用失效，见 [惰性服务访问](../concepts/lazy-service-access.md)）：

```ts
// Agent 的标准姿势（plugin-agent/src/index.ts:451-464）
const sm = ctx.getService<SessionManagerService>('session-manager');
const resolved = sm && sessionId ? sm.resolveConfig(sessionId, platform) : undefined;
// sm 缺失 → resolved 为 undefined → 回落到全局 ServicePreference / 默认行为，不崩
```

写操作的标准错误边界是「服务不可用即报错或返回错误对象」，参考 action 写法 `if (!sm) throw new Error('session-manager 服务不可用')`（`plugin-session-manager/src/index.ts:145-146`）或工具里 `return JSON.stringify({ error: 'session-manager 服务不可用' })`（`plugin-subtask/src/index.ts:136-137`）。

### 5.2 消费侧窄化类型（推荐）

只用到 `resolveConfig` 的少数字段时，可声明一个**窄接口**而非 import 全量 `SessionManagerService`，避免包循环 / 不必要依赖。`plugin-persona` 就这么做（`plugin-persona/src/index.ts:31-44`）：

```ts
interface SessionConfigResolver {
  resolveConfig(sessionId: string, platform?: string):
    { persona?: string; disableOutputFormat?: boolean; clientSideJsonRendering?: boolean };
}
const sm = ctx.getService<SessionConfigResolver>('session-manager');
```

### 5.3 监听生命周期事件

子任务完成感知就是事件驱动：`completeSession()` 发 `session:completed`，等待方据此收尾（`plugin-session-manager/src/index.ts:697-698`）。

## 6. 配置 / 风险 → 影响（provider 与 consumer 必守）

### 6.1 `resolveConfig` 是 Agent 行为的单一事实源

LLM 选择、persona、工具分组、是否结构化输出全部从这里来。Provider 若漏掉某层合并或不删 `sessionDefaults`，会导致 Agent 静默用错模型/人设。实现里有一段**legacy 字段折叠**（老 WebUI 只发 flat `model` 不发 `provider`，需用已注册 llm entries 反查 provider 补齐 `llm:{provider,model}`），重写时这是真实存在过的坑——别只 delete 不折叠，否则用户切模型 100% 静默失败（`plugin-session-manager/src/index.ts:557-584`）。

### 6.2 会话隔离边界

`sessionId` 是隔离边界：`deleteSession` 会**递归删子会话**并经 `memory:clear` 钩子清空该会话历史（`plugin-session-manager/src/index.ts:594-644`）。消费方不要跨 `sessionId` 复用配置或历史。

### 6.3 子任务指令走顶层 `inputContext`（关键约定）

父会话给子任务下达的指令通过 **顶层 `SessionInfo.inputContext`** 传递，**不是**塞进 `metadata`：

- 写入：`plugin-subtask` `createChildSession(parentId, { inputContext: task, ... })`（`plugin-subtask/src/index.ts:171-177`）。
- 读取：子任务上下文注入中间件读 `session.inputContext`（顶层，`plugin-subtask/src/index.ts:558`）；返回给父会话时也是 `session.inputContext`（`plugin-subtask/src/index.ts:257, 501`）。

实现的 `createSession` 兼容两种来源但**顶层优先**：`inputContext: opts?.inputContext ?? (opts?.metadata?.inputContext)`（`plugin-session-manager/src/index.ts:497`）。Provider 必须保证 `inputContext` 能从顶层读出来——**只写进 metadata 不写顶层会让子任务读不到任务指令**。

### 6.4 子任务不可嵌套

`plugin-subtask` 在创建前检查 `parentSession?.parentId`，禁止子任务再开子任务（`plugin-subtask/src/index.ts:145-148`）。这是消费侧约定，不是服务硬约束——自定义协调器若复用会话树请自行守住，否则会无限递归派发。

### 6.5 标题生成会调 LLM

`generateTitle` 会真发一次 LLM `chat`（`think:false`，`temperature:0.3`），有成本与延迟；参考实现只对 `webui` / `cli` 平台自动触发，且异步不阻塞消息处理（`plugin-session-manager/src/index.ts:1004-1029, 705-776`）。第三方平台慎自动调。

## 7. 边界与坑

### 7.1 ★ 被「吞掉」的群消息会让会话卡在 `active`（审计标注）

会话状态由本插件**根据事件自治推进**：`inbound:message` 把会话翻到 `active`，再靠 `outbound:message` 或 `agent:turn:after` 翻回 `completed`（`plugin-session-manager/src/index.ts:970-999`）。但 Agent 的消息处理跑在 `agent:input:before` 中间件的 `next()` 内——**任何中间件不调用 `next()` 即可拦截整条消息**（`plugin-agent/src/index.ts:411-417`）。

群聊场景常见：一个「是否被 @ / 是否该响应」的门控中间件判定本条群消息不该回，于是**不调用 `next()` 直接吞掉**。此时：

- `inbound:message` 已经把会话置为 `active`；
- 但既没有 `outbound:message`（没回复），也没有 `agent:turn:after`（默认动作根本没进入，turn 没开始）；

→ 会话**永远停在 `active`（"进行中"）**。这与 silent/aborted 不同——后两者 Agent 仍会发 `agent:turn:after(outcome=silent|aborted)`，由 `agent:turn:after` 中间件兜底收口（`plugin-session-manager/src/index.ts:987-999`、`plugin-agent/src/index.ts:901-963`）；而**被中间件吞掉的消息连 turn 都没开始，没有任何终态事件**。

规避：

- **门控插件**应当尽量让该响应判定**发生在 `inbound:message` 流转之前**，或在拦截路径上补一个状态收口（例如显式把会话改回先前状态）。
- **自定义 provider** 不要把 `active` 当作「正在跑」的强保证；可加超时清扫或在 `getTree`/列表渲染侧对长时间 `active` 容错。
- 该 bug 的范围限于「平台门控吞消息」这类极少数路径；正常用户对话（webui/cli/被 @ 的群消息）四条终态路径都覆盖到位。

### 7.2 配置解析是同步快照

`resolveConfig` 读内存 Map，不 `await`、不持久等待。若你在 provider 切换瞬间调用，可能拿到旧 manager 的快照——遵守 §5.1「每次现取」即可。

### 7.3 持久化是延迟刷盘 + 进程退出兜底

写操作走 `markDirty()` → 1s 防抖刷盘，进程退出在 `app:stopping` 阶段强制 `shutdown()` 落盘（`plugin-session-manager/src/index.ts:436-466, 915-922, 1031-1034`）。崩溃（非正常退出）可能丢失最后 ~1s 的会话元数据变更。重写 provider 时若要更强一致性，请在关键写操作后同步落盘。

## 8. 交叉链接

- [服务模型](../concepts/service-model.md) —— DI 按名解析、同名竞争（preference > priority > 注册顺序）、`ServicePriority`。
- [惰性服务访问](../concepts/lazy-service-access.md) —— 为何每次 `getService()`、不要缓存。
- [清单元数据](../concepts/manifest-metadata.md) —— `provides`/`inject` 与 `package.json aalis.service` 双源同步与校验。
- [消息-LLM 流水线](../concepts/message-llm-pipeline.md) —— `resolveConfig` 的产物如何进入 `agent:input:before` / `agent:llm:before` / `agent:turn:after`。
- [Agent 服务](agent.md) —— 头号消费方。
- [Memory 服务](memory.md) —— 会话元数据与历史的持久化后端。
- [会话级工具状态服务](tool-session.md) —— 按 `sessionId` 隔离的工具态，与本服务共享同一隔离边界。
- [Persona 服务](persona.md) / `plugin-persona` —— 消费侧窄化类型范例（§5.2）。

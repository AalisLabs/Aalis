# memory 服务

## 1. 定位

会话记忆 / 持久化层：把对话消息（`Message`）按 `sessionId` 落库，并提供「拉历史、范围查询、跨会话最近消息、归档裁剪、结构化元数据」等读写能力。它是 agent 构建 LLM 上下文、checkpoint 回滚、summary 压缩等一切「记得住对话」功能的底座。

- 服务注册名：`getService('memory')`（`ServiceTypeMap.memory = MemoryService`，见 `packages/plugin-memory-api/src/index.ts:107-111`）
- 契约包：`@aalis/plugin-memory-api`
- 参考实现：`@aalis/plugin-memory-sqlite`（默认推荐）、`@aalis/plugin-memory-inmemory`（fallback）、`@aalis/plugin-memory-mongodb`

> 该服务只负责「存与取」，不负责「写进去」的内容编排。真正决定一条消息长什么样的是 `message-archive`（见下文「谁消费」）。

## 2. 契约

接口与类型全部来自 `packages/plugin-memory-api/src/index.ts`。消息类型 `Message` 来自 `@aalis/plugin-message-api`（`packages/plugin-message-api/src/index.ts:82`，含 `role / content / kind / timestamp / segments / metadata / reasoningContent / toolCalls`）。

### 2.1 核心接口（必须实现）

`MemoryService`（`index.ts:35-88`）的前四个方法构成「必须」面：

```ts
saveMessage(sessionId: string, message: Message): Promise<void>;     // index.ts:36
getHistory(sessionId: string, limit?: number): Promise<Message[]>;   // index.ts:37 —— 仅未归档，按 timestamp 升序
clearSession(sessionId: string): Promise<void>;                      // index.ts:38
```

`getHistory` 的语义（由参考实现确立，`plugin-memory-sqlite/src/index.ts:192-205`）：只返回 `archived=0` 的消息；内部先 `ORDER BY timestamp DESC LIMIT ?` 取最近 N 条，再升序输出；默认 `limit=50`。

### 2.2 可选方法（`?` 修饰，按需实现）

```ts
clearAll?(): Promise<void>;                                          // index.ts:40 清空所有会话 + 归档
trimHistory?(sessionId, keepRecent): Promise<number>;               // index.ts:42 归档旧消息，保留最近 keepRecent 条活跃，返回归档条数
getFullHistory?(sessionId, limit?): Promise<Message[]>;             // index.ts:44 含已归档，供 UI 展示

// 范围查询（向量召回时扩展上下文窗口用）
getMessagesBySessionRange?(
  sessionId: string, fromTs: number, toTs: number,
  roles?: Array<Message['role']>, excludeKinds?: string[],
): Promise<Message[]>;                                               // index.ts:53-59 [fromTs,toTs] 升序

// 跨会话最近 N 条（跨会话历史注入用）
getRecentMessagesAcrossSessions?(
  query: RecentMessagesAcrossSessionsQuery,
): Promise<RecentMessageRecord[]>;                                  // index.ts:70

// 结构化元数据（namespace 隔离，(namespace,key) 唯一）—— 摘要等场景的旁路存储
saveMetadata?(namespace, key, data): Promise<void>;                // index.ts:75
getMetadata?(namespace, key): Promise<Record<string,unknown>|undefined>; // index.ts:77
listMetadata?(namespace): Promise<Array<{key; data}>>;             // index.ts:79
deleteMetadata?(namespace, key): Promise<void>;                    // index.ts:81

updateMessageContent?(sessionId, oldText, newText, recentLimit?): Promise<number>; // index.ts:84 最近 N 条内文本替换
deleteMessagesByTimestamps?(sessionId, timestamps): Promise<number>; // index.ts:87 按时间戳批删（回滚整轮）
```

### 2.3 跨会话查询类型

`RecentMessagesAcrossSessionsQuery`（`index.ts:6-27`）：

- `limit: number`（必填）— 按 `timestamp DESC` 取最近 N 条，最终升序返回。
- `sinceTs?` / `platform?`（按 `metadata.platform` 过滤）/ `excludeSessionIds?`（通常排除当前会话避免与会话内 history 重复）。
- `roles?`：省略时实现应默认 `['user','assistant']`（参考实现 `plugin-memory-sqlite/src/index.ts:241`；契约注释 `index.ts:15`）。
- `kinds?` 白名单 / `excludeKinds?` 黑名单（黑名单优先，`index.ts:17-26`）。

`RecentMessageRecord = { sessionId: string; message: Message }`（`index.ts:30-33`）—— 结果按条带上来源 `sessionId`。契约对实现的硬性约束写在 `index.ts:64-69`：仅返回未归档、`DESC` 取 limit 后升序、按 platform/excludeSessionIds/roles/sinceTs 过滤。

### 2.4 配套的钩子与事件契约（同包声明）

`plugin-memory-api` 还通过 declaration merging 向 `@aalis/core` 注入：

- Hook `'memory:clear'`（`index.ts:91-103`）：统一编排各子系统的记忆清除，`scope: 'session'|'all'`，中间件把各子系统结果填进 `results[]`。persona 等插件即靠监听此钩子参与清除（`plugin-persona/src/index.ts:583-585`），**不是**直接调 memory 服务。
- Event `'memory:messages-deleted'`（`index.ts:120`）：消息被按时间戳删除后广播，下游存储（如向量库）同步清理。
- Event `'history:changed'`（`index.ts:122`）：会话历史结构性变化，前端重新拉取。
- Event `'session:compress'` / `'session:compressing'`（`index.ts:133-136`）：会话记忆压缩请求与进度。

## 3. 谁提供 / 谁消费

### 提供方（reference impls）

| 包 | priority | 说明 |
|---|---|---|
| `plugin-memory-sqlite` | `10` | 默认持久化，`inject.required=['storage']`，全量实现所有可选方法（`src/index.ts:430-432`） |
| `plugin-memory-inmemory` | `-100` | 进程内 fallback，不持久化，同样全量实现可选方法（`src/index.ts:234-236`） |
| `plugin-memory-mongodb` | 默认 | MongoDB 后端（`src/index.ts:11`） |

DI 按名选winner：preference > priority > 注册顺序（见 `docs/concepts/service-model.md`）。sqlite(10) 默认压过 inmemory(-100)，两者同时装时 sqlite 胜出。

### 消费方（典型读写点）

- **`plugin-message-archive`**（写入唯一入口）：`saveMessage` 经此封装，是消息进库的标准路径（`src/index.ts:92-99,166,211`）。它声明 `inject.required=['memory']`。
- **`plugin-agent`**（构建 LLM 上下文）：`memory.getHistory(sessionId, historyLimit)` 拉历史拼进 messages（`src/index.ts:998-1002`）。
- **`plugin-checkpoint`**（回滚）：通过懒查 Proxy 持有 memory，调 `deleteMessagesByTimestamps` 并 emit `memory:messages-deleted` / `history:changed`（`src/index.ts:133-153`）。
- **`plugin-memory-summary`**（压缩）：`getHistory(...,200)` + `trimHistory` 裁剪，摘要本体存进 `saveMetadata/getMetadata`（namespace `SUMMARY_NAMESPACE`，`src/index.ts:158-186,265,344`）。
- **`plugin-memory-vector`**（召回）：listen `memory:messages-deleted` 清同时间戳向量，并用 `getMessagesBySessionRange` 扩窗（`src/index.ts:257`）。
- 其余广泛消费：`session-manager`、`user-profile`、`user-relation`、`media`、`commands`、`todo-list`、`tool-session`、`file-reader`、`maimai`、`adapter-onebot`、`image-sender` 等。

## 4. 写一个 provider

### 最小必须 vs 可选

必须实现 `saveMessage` / `getHistory` / `clearSession`。其余方法是 `?` 可选——**但**：
- 不实现 `getRecentMessagesAcrossSessions` → 跨会话历史注入功能直接 no-op。
- 不实现 `trimHistory` / `clearAll` → summary 压缩、全局清除会跳过。
- 不实现 `saveMetadata` 系列 → 摘要持久化无处可放。
- 不实现 `deleteMessagesByTimestamps` → checkpoint 回滚失效。

参考实现（sqlite、inmemory）都把可选面**全部实现**了，第三方若想做「能替换默认 memory」的完整后端，建议对齐它们。消费方对可选方法一律用 `if (memory.trimHistory)` / `memory.saveMetadata!` 这种存在性守卫，所以缺失不会崩，只是降级。

### 双源元数据必须同步

`provides` / `inject` 既要在源码导出，也要写进 `package.json` 的 `aalis.service`（见 `docs/concepts/manifest-metadata.md`）。sqlite 的两处：

源码（`plugin-memory-sqlite/src/index.ts:17-21`）：
```ts
export const provides = ['memory'];
export const inject = { required: ['storage'] };
```
`package.json` `aalis.service`：
```json
{ "service": { "provides": ["memory"], "required": ["storage"] } }
```

### 可编译最小骨架

```ts
import type { ConfigSchema, Context } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { Message } from '@aalis/plugin-message-api';

export const name = '@aalis/plugin-memory-myimpl';
export const provides = ['memory'];
// 若依赖 storage 落盘：export const inject = { required: ['storage'] };

class MyMemoryService implements MemoryService {
  private store = new Map<string, Message[]>();
  async saveMessage(sessionId: string, message: Message): Promise<void> {
    const arr = this.store.get(sessionId) ?? [];
    arr.push(message);
    this.store.set(sessionId, arr);
  }
  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    const arr = this.store.get(sessionId) ?? [];
    // 契约：仅未归档、按 timestamp 升序、取最近 limit 条
    return arr.slice(-limit);
  }
  async clearSession(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }
  // 可选方法按需补全（trimHistory / getRecentMessagesAcrossSessions / *Metadata ...）
}

export function apply(ctx: Context): void {
  // priority 决定与 sqlite(10)/inmemory(-100) 的竞争结果
  ctx.provide('memory', new MyMemoryService(), { priority: 10 });
}
```

> 若 provider 是单实例（不按子上下文分裂），不需要 per-entry `entryId`；memory 后端历来都是整进程一个，直接 `ctx.provide('memory', svc, { priority })` 即可。

## 5. 标准消费姿势

**永远懒查，不要缓存。** memory provider 可能被 bounce/重载，缓存的裸引用会失效——`message-archive` 把原因写得很直白（`src/index.ts:91-92`：「ServiceRegistry.get 返回裸引用，apply 时缓存会在 memory provider 重载后失效」）。详见 `docs/concepts/lazy-service-access.md`。

```ts
import type { MemoryService } from '@aalis/plugin-memory-api';

const memory = ctx.getService<MemoryService>('memory');
if (!memory) return; // memory 是可选依赖时：缺失就降级，别抛
try {
  const history = await memory.getHistory(sessionId, 50);
  // ...
} catch (err) {
  ctx.logger.warn('获取历史消息失败:', err); // agent 的做法：吞掉、空历史继续
}
```

- **硬依赖**：声明 `inject.required=['memory']`（如 message-archive），缺失时框架不会加载你的插件；运行期仍建议 `if (!m) throw`（`message-archive/src/index.ts:93`）。
- **可选依赖**：直接 `getService` + null 守卫降级（agent 的做法，`src/index.ts:998-1021`）。
- **可选方法守卫**：调可选方法前判存在性 —— `if (memory.trimHistory) await memory.trimHistory(...)`（`memory-summary/src/index.ts:344`）。
- **跨 provider 重载安全**：需要长期持有引用时，用懒查 Proxy（checkpoint 的做法，`src/index.ts:133-140`）。

## 6. 能力 / 风险 → 影响

- **本服务不做 authority 鉴权**。memory 是内部基础设施服务，调用方拿到引用即可读写任意 `sessionId` 的全部消息；没有 visibility/risk 分级、没有逐调用确认。跨会话隔离纯靠调用方传对 `sessionId`，以及 `getRecentMessagesAcrossSessions` 的 `excludeSessionIds`/`platform` 过滤。**provider 不得自行加额外鉴权门**，否则会破坏 agent 流水线。authority 模型见 `docs/core/authority.md` 与 `docs/concepts/security-model.md`。
- **持久化要走 storage 契约**：sqlite 后端不直接拼文件系统路径，而是 `createStorageGateway(ctx)` + `storage.resolveLocalPath(uri, 'write')` 解析 `'<root>:/path'`（`plugin-memory-sqlite/src/index.ts:405-416`，默认 `data:/aalis.db`）。storage 不是沙箱（见 `docs/concepts/storage-uri-grammar.md`），但用它能拿到框架统一的根隔离与路径解析；自写 provider 落盘时应沿用此姿势而非裸 `fs`。
- **删除要广播**：实现 `deleteMessagesByTimestamps` 的 provider，删除后下游（向量库/前端）靠 `memory:messages-deleted` / `history:changed` 事件同步——但 emit 事件是**消费方**（checkpoint）的责任，不是 memory 服务自身（`plugin-checkpoint/src/index.ts:143-152`）。
- **PII 注意**：消息原文（含用户昵称、平台 ID 等）会原样落库。示例代码一律用占位符，勿在 configSchema/默认值/日志里硬编码真实账号信息。

## 7. 边界与坑

- **`getHistory` 只看未归档**，`getFullHistory` 才含归档。trim 后旧消息变 `archived=1`，agent 上下文看不到它们；summary 正是靠这个把超长历史折叠成摘要再 trim（`memory-summary/src/index.ts:344`）。新 provider 若不维护 `archived` 字段，`trimHistory` 行为会与参考实现不一致。
- **`excludeKinds` 的 NULL 语义**：sqlite/mongodb 采用「`kind IS NULL` 不被排除」的保守语义（`plugin-memory-sqlite/src/index.ts:228-229`），新后端应对齐，否则跨实现切换时控制类消息的过滤行为会漂移。
- **跨会话查询的 limit 收窄 + overscan**：`getRecentMessagesAcrossSessions` 会把 `query.limit` 收窄到 `crossSessionMaxLimit`（默认 1000），且 `platform`/`excludeSessionIds` 走内存后过滤——sqlite 用 8x overscan 拉候选再过滤（`src/index.ts:240-287`）。若候选 overscan 不足，极端过滤下可能返回不满 limit 条。
- **`updateMessageContent` / `deleteMessagesByTimestamps` 作用域**：前者只在最近 `recentLimit`（默认 100）条内做文本替换；后者 sqlite 因变量上限 999 而分 500/批事务删（`src/index.ts:373-390`）。新 provider 注意同等批量约束。
- **没有 schema 校验**：`saveMessage` 直接信任传入的 `Message`，不校验 role/kind 合法性。脏数据由调用方（message-archive）负责清洗。

## 8. 交叉链接

- 概念：[`docs/concepts/service-model.md`](../concepts/service-model.md)（DI 选 winner 规则）、[`docs/concepts/lazy-service-access.md`](../concepts/lazy-service-access.md)（必须懒查的原因）、[`docs/concepts/manifest-metadata.md`](../concepts/manifest-metadata.md)（provides/inject 双源）、[`docs/concepts/message-llm-pipeline.md`](../concepts/message-llm-pipeline.md)（消息如何被 archive→memory→agent 流转）、[`docs/concepts/storage-uri-grammar.md`](../concepts/storage-uri-grammar.md)（持久化路径）、[`docs/concepts/security-model.md`](../concepts/security-model.md)。
- 核心：[`docs/core/service.md`](../core/service.md)、[`docs/core/authority.md`](../core/authority.md)、[`docs/core/events.md`](../core/events.md)、[`docs/core/context.md`](../core/context.md)。

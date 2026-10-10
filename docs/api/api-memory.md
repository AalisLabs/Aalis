# api-memory — 对话历史与元数据存储契约

**包名**: `@aalis/api-memory`  
**源码**: `packages/api-memory/src/index.ts`  
**实现**: `@aalis/plugin-memory-inmemory`, `@aalis/plugin-memory-sqlite`, `@aalis/plugin-memory-mongodb`

## 概述

`MemoryService` 是 Agent 的"长期记忆"——保存每轮 Message、按 sessionId 检索历史、提供结构化元数据 K/V 存储。可以同时装载多个实现，但每个消费方的 `memory` 只选中一家（本插件偏好 > 全局偏好 > 优先级 > 注册顺序）；语义检索由 `plugin-memory-vector` 经 vectorstore 另行提供，不是 `MemoryService` 的实现。描述符 `memory` 不给 bind，业务层就是 `MemoryService` 形状的活句柄（`caps.memory.use`）。

## 核心方法

```ts
interface MemoryService {
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
  archiveOldest(sessionId: string, count: number): Promise<number>;
  clearAll?(): Promise<void>;
  getFullHistory?(sessionId: string, limit?: number): Promise<Message[]>;
  getMessagesBySessionRange?(
    sessionId: string,
    fromTs: number,
    toTs: number,
    roles?: Array<Message['role']>,
    excludeKinds?: string[],
  ): Promise<Message[]>;
  getRecentMessagesAcrossSessions?(query: RecentMessagesAcrossSessionsQuery): Promise<RecentMessageRecord[]>;

  saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void>;
  getMetadata(namespace: string, key: string): Promise<Record<string, unknown> | undefined>;
  listMetadata(namespace: string): Promise<MetadataEntry[]>;
  listMetadataKeys?(namespace: string): Promise<string[]>;
  deleteMetadata(namespace: string, key: string): Promise<void>;
  commitMetadata(ops: readonly MetadataOp[]): Promise<void>;

  updateMessageContent?(sessionId: string, oldText: string, newText: string, recentLimit?: number): Promise<number>;
  deleteMessagesByTimestamps?(sessionId: string, timestamps: number[]): Promise<number>;
}
```

- **`getHistory`**：最近 `limit` 条活跃（未归档）消息；`limit` 为 `Infinity` 时返回全部活跃消息。
- **`archiveOldest`**：把最早的 `count` 条活跃消息标为归档（顺序与 `getHistory` 相同），返回归档条数；`count` 为 0 时什么都不归档。归档的消息不再进 `getHistory`，`getFullHistory` 照样有。必填：压缩靠它落定，缺了没有降级可走。

## 消费方式

```ts
import { memory } from '@aalis/api-memory';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-memory',
  uses: { memory },
  apply({ memory }) {
    if (!memory.present) return;
    void memory.use.getHistory('session-1', 20);
  },
});
```

## 会话设置项：记忆召回范围

```ts
type MemoryRecallScope = 'session' | 'platform' | 'all';

// 经 declaration merging 加进 api-session-manager 的 SessionConfig
interface SessionConfig {
  memoryRecallScope?: MemoryRecallScope;
}

const MEMORY_RECALL_SCOPE_SETTING: SessionSetting;   // key 'memoryRecallScope'，select，各种会话适用，advanced
```

房间的记忆召回范围：`session` 只召回本会话，`platform` 最多同平台，`all` 不限。它只能收窄、不能放宽各插件自己的范围配置，写得比插件配置宽时按插件配置；随子会话复制（不是 liveOnly），否则经子任务就绕过了收窄。跨会话取料的插件（[plugin-memory-history](../plugins/plugin-memory-history.md)、[plugin-memory-vector](../plugins/plugin-memory-vector.md)、[plugin-tool-session](../plugins/plugin-tool-session.md)、[plugin-user-relation](../plugins/user-relation.md)）都遵守它，各自登记这同一份定义（[api-session-manager](./api-session-manager.md) 允许几个插件以同一份定义登记同一个键）：只要其中一个在场这一项就有效，不会因为某一个插件停用而让其余插件不再收窄。

## 压缩服务

```ts
import { compression } from '@aalis/api-memory';

interface CompressionService {
  compress(sessionId: string, request: { reason: 'manual' }): Promise<void>;
  compressAt(sessionId: string, platform?: string): number | undefined;   // 这个会话的自动压缩线（占窗口比例），0 时为 undefined
}
```

服务名 `compression`。压缩把切分点之前的全部活跃历史压成一份摘要，切分点之后到达的消息原样接在摘要后面，提供方是 [plugin-memory-summary](../plugins/plugin-memory-summary.md)。

- **`compress`**：`manual` 是 owner 手动，短对话也完整压一次。压成才落定；没压成时以原因拒绝（这个会话正在压缩、记忆或摘要模型不在、模型失败、期间被清空或历史被改动）。没有可压的对话（历史为空、只剩分隔标记）时什么都不做，照常落定。用量或会话条数到线的自动压缩由提供方在后台自己发起，不经这个方法。
- **`compressAt`**：与 api-agent 的 `token:usage` 里 `usageRatio` 同一口径，按会话取。实际在它与裁剪预算占窗口的比例（`tokenBudget / contextWindow`）中较小的那个上压缩（见下文「触发判定」），界面的压缩线取这个较小值。`platform` 是入口平台：没有出生平台的会话按它选平台档。
- **进度**：事件 `session:compressing { sessionId, status: 'start' | 'done' | 'error' }`，会话服务转成时间线上的压缩通知。只在真的开始压时报：`start` 之后压成报 `done`、没压成报 `error`；什么都不做的与开始之前就失败的（记忆不在、读不出历史）不报。
- **使用方**：[plugin-session-server](../plugins/plugin-session-server.md) 的 `session/compress` 调它，功能位的「压缩」与用量条目的 `compressAt` 看它在不在。

### 触发判定

```ts
interface CompressionUsage {
  used: number;            // 这次调用的输入量（token）
  contextWindow: number;   // 所用模型的上下文窗口（token）
  tokenBudget: number;     // 硬裁剪的上限（token）
  compressible: number;    // 历史与工具结果占的 token，按硬裁剪之前的列表算：全量压缩能压掉的部分
  trimmed: boolean;        // 经过了硬裁剪：到了丢内容的地步
  historyMessages: number; // 会话历史的条数
}
interface CompressionLines {
  compressAt?: number;     // 自动压缩线，占窗口比例；缺省或 0 不按用量判
  historyLimit?: number;   // 条数线；缺省或 0 不按条数判
}

function compressionDue(usage: CompressionUsage, lines: CompressionLines): boolean;
```

判定是否该压缩的纯函数，两维任一到线即该压缩。

- **用量一维**：线是 `min(compressAt × contextWindow, tokenBudget)`，压缩线写得比裁剪预算还高时以裁剪预算为准，压缩先于硬裁剪。用量到线或经过了硬裁剪（`trimmed`：到了丢内容的地步），且 `compressible` 至少是线的一半时该压缩。后一个条件就是回差：压完只剩切分点之后的几条，到不了线的一半，不会接着再触发；人设、工具定义这些压不掉的部分再大也不会让它空转。
- **条数一维**：`historyMessages` 到 `historyLimit` 时该压缩。全量压缩之后只剩分隔标记与切分点之后的几条，远不到线。

没压成之后多久再试由调用方决定，不在这个函数里。

## 钩子（HookContextMap）

经 declaration merging 注入 `@aalis/api-hooks` 的 `HookContextMap`（见 [api-hooks](./api-hooks.md)）：

```ts
'memory:clear': {
  scope: 'session' | 'all';
  types?: string[];
  sessionId?: string;
  results: Array<{ source; type?; success; message }>;
}
```

`plugin-memory-summary` / `plugin-memory-vector` 等通过订阅此钩子统一参与"清空对话"操作。`clearAll` 只清消息与归档、不清元数据：在元数据里存了数据的插件，要挂这个中间件按 `scope` 与 `types` 清理自己的命名空间。结果行的 `type` 是这一行所属的清理类型（取值同 `/clear --type`），处理某个清理类型的中间件须在各行标注它，成败都标：`/clear` 据此判断显式指定的类型有没有处理者，不标注会被回执误报为「没有已启用的插件处理」。

整体清空自己的命名空间用 `clearMetadataNamespaces(mem, namespaces, logger)`，它在一次 `commitMetadata` 里删掉这些命名空间的全部条目，返回各命名空间删掉的键（与传入顺序相同）。`listMetadata` 会跳过读不出的条目（数据损坏、不是对象），按它枚举键删不掉这些条目；后端实现了只列键的 `listMetadataKeys` 时，这个函数按它列键，读不出的条目一并删除、计入返回的键，并经 `logger` 记一条 info 点名（`namespace/key`，超过 10 条只列前 10 条）。后端没有实现时退回 `listMetadata`，读不出的条目留在库里。

## 实现者

- [@aalis/plugin-memory-inmemory](../plugins/plugin-memory-inmemory.md) — 进程内 Map
- [@aalis/plugin-memory-sqlite](../plugins/plugin-memory-sqlite.md) — 持久化（默认）
- [@aalis/plugin-memory-mongodb](../plugins/plugin-memory-mongodb.md) — 远端
- [@aalis/plugin-memory-vector](../plugins/plugin-memory-vector.md) — 向量检索（消费方，非实现方；提供 `semantic-memory`，依赖 embedding + vectorstore）
- [@aalis/plugin-memory-summary](../plugins/plugin-memory-summary.md) — 压缩摘要插件（消费方，非实现方）

## 相关

- 协议层 `Message` 在 `@aalis/schema-message`
- 向量检索见 [api-vectorstore](./api-vectorstore.md)

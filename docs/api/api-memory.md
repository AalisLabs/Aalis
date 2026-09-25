# api-memory — 对话历史与元数据存储契约

**包名**: `@aalis/api-memory`  
**源码**: `packages/api-memory/src/index.ts`  
**实现**: `@aalis/plugin-memory-inmemory`, `@aalis/plugin-memory-sqlite`, `@aalis/plugin-memory-mongodb`

## 概述

`MemoryService` 是 Agent 的"长期记忆"——保存每轮 Message、按 sessionId 检索历史、提供结构化元数据 K/V 存储。可以同时装载多个实现，但 `memory` 服务按名只选一个胜者（偏好 > 优先级 > 注册顺序）；语义检索由 `plugin-memory-vector` 经 vectorstore 另行提供，不是 `MemoryService` 的实现。描述符 `memory` 是普通调用型 `ServiceRef<MemoryService>`。

## 核心方法

```ts
interface MemoryService {
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
  clearAll?(): Promise<void>;
  trimHistory?(sessionId: string, keepRecent: number): Promise<number>;
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
  deleteMetadata(namespace: string, key: string): Promise<void>;
  commitMetadata(ops: readonly MetadataOp[]): Promise<void>;

  updateMessageContent?(sessionId: string, oldText: string, newText: string, recentLimit?: number): Promise<number>;
  deleteMessagesByTimestamps?(sessionId: string, timestamps: number[]): Promise<number>;
}
```

## 消费方式

```ts
import { memory } from '@aalis/api-memory';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-memory',
  uses: { memory },
  apply({ memory }) {
    const svc = memory.current;
    if (!svc) return;
    void svc.getHistory('session-1', 20);
  },
});
```

## 钩子（HookContextMap）

经 declaration merging 注入 `@aalis/api-hooks` 的 `HookContextMap`（见 [api-hooks](./api-hooks.md)）：

```ts
'memory:clear': {
  scope: 'session' | 'all';
  types?: string[];
  sessionId?: string;
  results: Array<{ source; success; message }>;
}
```

`plugin-memory-summary` / `plugin-memory-vector` 等通过订阅此钩子统一参与"清空对话"操作。

## 实现者

- [@aalis/plugin-memory-inmemory](../plugins/plugin-memory-inmemory.md) — 进程内 Map
- [@aalis/plugin-memory-sqlite](../plugins/plugin-memory-sqlite.md) — 持久化（默认）
- [@aalis/plugin-memory-mongodb](../plugins/plugin-memory-mongodb.md) — 远端
- [@aalis/plugin-memory-vector](../plugins/plugin-memory-vector.md) — 向量检索（消费方，非实现方；提供 `semantic-memory`，依赖 embedding + vectorstore）
- [@aalis/plugin-memory-summary](../plugins/plugin-memory-summary.md) — 压缩摘要插件（消费方，非实现方）

## 相关

- 协议层 `Message` 在 `@aalis/schema-message`
- 向量检索见 [api-vectorstore](./api-vectorstore.md)

# plugin-memory-api — 对话历史与元数据存储契约

**包名**: `@aalis/plugin-memory-api`  
**源码**: `packages/plugin-memory-api/src/index.ts`  
**实现**: `@aalis/plugin-memory-inmemory`, `@aalis/plugin-memory-sqlite`, `@aalis/plugin-memory-mongodb`, `@aalis/plugin-memory-vector`

## 概述

`MemoryService` 是 Agent 的"长期记忆"——保存每轮 Message、按 sessionId 检索历史、提供结构化元数据 K/V 存储。多实现并存：通常 inmemory + sqlite 用作不同语义存储（短时/持久），vector 用作语义检索。

## 核心方法

```ts
interface MemoryService {
  // 历史
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
  clearAll?(): Promise<void>;
  trimHistory?(sessionId: string, keepRecent: number): Promise<number>;   // 归档旧消息
  getFullHistory?(sessionId: string, limit?: number): Promise<Message[]>; // 含已归档
  getMessagesBySessionRange?(
    sessionId: string,
    fromTs: number,
    toTs: number,
    roles?: Array<Message['role']>,
  ): Promise<Message[]>;

  // 结构化元数据（namespace 隔离，key 唯一）
  saveMetadata?(namespace: string, key: string, data: Record<string, unknown>): Promise<void>;
  getMetadata?(namespace: string, key: string): Promise<Record<string, unknown> | undefined>;
  listMetadata?(namespace: string): Promise<Array<{ key; data }>>;
  deleteMetadata?(namespace: string, key: string): Promise<void>;

  // 编辑
  updateMessageContent?(sessionId: string, oldText: string, newText: string, recentLimit?: number): Promise<number>;
  deleteMessagesByTimestamps?(sessionId: string, timestamps: number[]): Promise<number>;
}
```

## Capability 框架

```
history           最基础：saveMessage + getHistory
metadata          结构化元数据存储
content-update    支持 updateMessageContent
message-delete    支持 deleteMessagesByTimestamps
```

依赖声明：

```ts
export const inject = {
  required: ['memory'],
};
```

## 钩子（HookContextMap）

```ts
'memory:clear': {
  scope: 'session' | 'all';
  types?: string[];                     // 指定清除的子系统
  sessionId?: string;
  results: Array<{ source; success; message }>;
  rollbacks: Array<{ source; fn: () => Promise<void> }>;
}
```

`plugin-memory-summary / plugin-memory-vector` 等通过订阅此钩子统一参与"清空对话"操作。

## 实现者

- [@aalis/plugin-memory-inmemory](../plugins/plugin-memory-inmemory.md) — 进程内 Map
- [@aalis/plugin-memory-sqlite](../plugins/plugin-memory-sqlite.md) — 持久化（默认）
- [@aalis/plugin-memory-mongodb](../plugins/plugin-memory-mongodb.md) — 远端
- [@aalis/plugin-memory-vector](../plugins/plugin-memory-vector.md) — 向量检索（依赖 embedding + vectorstore）
- [@aalis/plugin-memory-summary](../plugins/plugin-memory-summary.md) — 压缩摘要插件（消费方，非实现方）

## 相关

- 协议层 `Message` 在 `@aalis/core`
- 向量检索见 [plugin-vectorstore-api](./plugin-vectorstore-api.md)

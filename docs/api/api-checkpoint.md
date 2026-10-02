# api-checkpoint — 回合检查点契约

**包名**: `@aalis/api-checkpoint`  
**源码**: `packages/api-checkpoint/src/index.ts`  
**实现**: `@aalis/plugin-checkpoint`

## 概述

一轮对话里经受控存储做的写入、删除与移动，在改动发生前备份原内容，事后可以按回合回滚。本包定义服务描述符 `checkpoint`（服务名 `checkpoint`）、服务接口 `CheckpointService` 与回滚结果的类型，不含实现。

两类使用方：

- **存储实现**在每次改动前探测本服务，在场就调 `beforeMutate` 留一次快照机会。`@aalis/plugin-storage-local` 经 `services.get(checkpoint)` 动态查它，不写进 `uses`：checkpoint 自己要用存储，写进 `uses` 会让两者互为依赖。
- **会话服务**按回合回滚（会话协议的 `turn/rewind`，见 [api-session-protocol](./api-session-protocol.md)）。

回合 id 与 agent 的回合 id 相同（见 [api-agent](./api-agent.md#回合-id)），调用方可以直接拿 `agent:turn:after`、`outbound:stream` 等带的 `turnId` 去回滚那一轮。

## 服务接口

```ts
interface CheckpointService {
  beforeMutate(
    uri: string,
    op: 'write' | 'delete' | 'rename',
    loadOriginal: () => Promise<{ data: Buffer; size: number } | null>,
    toUri?: string,
  ): Promise<void>;
  rollback(sessionId: string, turnId: string): Promise<RollbackResult>;
  rollbackWithChat(sessionId: string, turnId: string): Promise<RollbackWithChatResult>;
}
```

- `beforeMutate`：存储每次改动前都调它，写入不在任何一轮里时直接返回，不读原文件。改动记进调用所在的那一轮：同一会话里同时有几轮在跑时（agent 按会话与来源分 lane），按写入发生在哪一轮的异步上下文里归属。同一 URI 在一轮里只备份最早的原内容；`loadOriginal` 只有「不存在」与「是目录」返回 `null`，读不出来要抛出，否则回合前就存在的文件会被记成本轮新建、回滚时被删掉。`toUri` 只对 `rename` 有意义，回滚时据它原路移回。
- `rollbackWithChat`：先回滚文件，再按这一轮记下的消息时间戳删除这一轮的对话消息，并发出 `memory:messages-deleted` 与 `history:changed`。

列出回合、读取清单与清理检查点是实现自己的事（plugin-checkpoint 的页面动作与 `memory:clear` 中间件），不在契约里。

## 类型

```ts
interface RollbackResult {
  ok: boolean;
  restored: string[];
  deleted: string[];
  errors: Array<{ uri: string; reason: string }>;
  alsoChangedBy: Array<{ uri: string; turnIds: string[] }>;
}

interface RollbackWithChatResult extends RollbackResult {
  deletedMessages: number;
  chatDeleted: boolean;
}
```

`alsoChangedBy` 列出这一轮改过、同一会话里另有回合也改过的文件（含移动的目标端，按这一轮清单里的顺序）与那些回合的 id（按开始时间）。回滚把文件恢复成这一轮第一次改动前的内容，那些回合在这之后做的改动会一并被撤掉。在这一轮开始前就已结束的回合不算，已提交的与还在跑的回合都算；时间戳只到毫秒，结束与开始落在同一毫秒的按算处理。回滚照常执行，`alsoChangedBy` 只是如实告知，由调用方决定怎么提示。

## 使用

```ts
import { checkpoint } from '@aalis/api-checkpoint';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-rewind',
  uses: { checkpoint: optional(checkpoint) },
  apply({ checkpoint }) {
    async function rewind(sessionId: string, turnId: string) {
      const result = await checkpoint.require().rollback(sessionId, turnId);
      for (const { uri, turnIds } of result.alsoChangedBy) {
        // 告诉用户：这些回合也改过 uri，回滚撤掉了它们在这一轮之后的改动
      }
      return result;
    }
  },
});
```

## 实现者列表

- [@aalis/plugin-checkpoint](../plugins/plugin-checkpoint.md)：回合边界、不记账的根、回滚细节与配置见插件页

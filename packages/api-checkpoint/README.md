# @aalis/api-checkpoint

回合检查点契约：`checkpoint` 服务描述符与对外类型。不含服务实现，默认实现是 `@aalis/plugin-checkpoint`。

## 角色

- `checkpoint`：服务描述符。存储实现在每次改动前探测它，在场就调 `beforeMutate` 留一次快照机会；会话服务经它按回合回滚。
- `CheckpointService`、`RollbackResult`、`RollbackWithChatResult`：服务接口与回滚结果的类型。

回合 id 与 agent 的回合 id 相同。一次改动记进它所在的那一轮，同一会话里同时有几轮在跑时按写入发生在哪一轮里归属；回滚某一轮时，同一会话里另有回合也改过的文件列在 `alsoChangedBy` 里。

## 安装

```bash
pnpm add @aalis/api-checkpoint
```

## 使用

```ts
import { checkpoint } from '@aalis/api-checkpoint';

// uses: { checkpoint: optional(checkpoint) }
const result = await caps.checkpoint.use.rollback(sessionId, turnId);
```

详见 [docs/api/api-checkpoint.md](../../docs/api/api-checkpoint.md)。

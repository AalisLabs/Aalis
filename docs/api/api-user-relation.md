# api-user-relation — 关系图契约

**包名**: `@aalis/api-user-relation`  
**源码**: `packages/api-user-relation/src/index.ts`  
**实现**: `@aalis/plugin-user-relation`

## 概述

本包定义 `userRelation` 描述符（服务名 `user-relation`）与查询接口 `UserRelationService`，不含实现。接口只收消费方实际用到的方法；关系图的完整实现类 `RelationService`（抽取、整理、工具、指令与页面动作背后的全部方法）仍由 `@aalis/plugin-user-relation` 导出，不属于契约。

## 服务接口

```ts
interface UserRelationService {
  getCommunityPeers(
    personId: string,
    limit?: number,
  ): Promise<{
    personId: string;
    communityId: string | null;
    communitySize: number;
    peers: Array<{ id: string; displayName: string; pagerank: number; communityId: string }>;
  }>;
}
```

- `personId` 形如 `<platform>:<userId>`。
- 返回与此人同社群的成员，按 PageRank 降序取前 `limit` 位；`limit` 默认 5，取值收在 1–20。
- 此人不在图中或没有社群标签时，`peers` 为空、`communitySize` 为 0；有标签时 `communitySize` 含本人。

## 获取方式

```ts
import { userRelation } from '@aalis/api-user-relation';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-relation',
  uses: { userRelation: optional(userRelation) },
  apply({ userRelation }) {
    // 在需要时现取；服务缺席时 current 为 undefined
    const relation = userRelation.current;
    if (!relation) return;
    void relation.getCommunityPeers('<platform>:<userId>', 5);
  },
});
```

`userRelation.current` 每次读取重新解析当前胜者，不要存进字段。

## 消费方

| 插件 | 用途 | 服务缺席时 |
|---|---|---|
| [plugin-user-profile](../plugins/plugin-user-profile.md) | 主发言者档案附一行「同社群活跃成员」 | 不附这一行，档案照常注入 |

## 实现者

- [@aalis/plugin-user-relation](../plugins/user-relation.md)

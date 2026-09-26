# @aalis/api-user-relation

关系图契约：`user-relation` 服务描述符与消费方用到的查询接口 `UserRelationService`。不含服务实现，默认提供者是 `@aalis/plugin-user-relation`。

## 角色

- `userRelation`：服务描述符（服务名 `user-relation`）。消费方以 `optional(userRelation)` 声明，缺席时自行降级。
- `UserRelationService`：只含消费方实际用到的查询面，目前是 `getCommunityPeers(personId, limit?)`（同社群成员，按 PageRank 降序）。关系图的完整实现类 `RelationService` 仍由 `@aalis/plugin-user-relation` 导出。

## 安装

```bash
pnpm add @aalis/api-user-relation
```

## 使用

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

## 许可

见仓库根目录 LICENSE。

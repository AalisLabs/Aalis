// ============================================================
// @aalis/api-user-relation — 关系图契约
//
// 只收消费方实际用到的查询面；关系图的完整实现（抽取、整理、工具、指令、页面）
// 住在默认提供者 @aalis/plugin-user-relation。
// ============================================================

import { defineService } from '@aalis/core';

/** `user-relation` 服务公开接口。 */
export interface UserRelationService {
  /**
   * 与某人同社群的成员，按 PageRank 降序取前 `limit` 位（默认 5，取值收在 1–20）。
   * `personId` 形如 `<platform>:<userId>`；此人不在图中或没有社群标签时 `communityId` 为 null、`peers` 为空、
   * `communitySize` 为 0，有标签时 `communitySize` 含本人。
   */
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

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const userRelation = defineService<UserRelationService>('user-relation');
